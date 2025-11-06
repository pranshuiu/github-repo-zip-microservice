require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { Octokit } = require('@octokit/rest');
const { google } = require('googleapis');
const archiver = require('archiver');
const fs = require('fs-extra');
const path = require('path');
const https = require('https');
const AdmZip = require('adm-zip');
const simpleGit = require('simple-git');

class GitHubRepoZipService {
  constructor() {
    this.octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN,
    });
    this.githubUsername = process.env.GITHUB_USERNAME;
    this.tempDir = path.join(__dirname, 'temp');
    this.zipDir = path.join(__dirname, 'zips');
    
    // Initialize Google Drive
    this.initGoogleDrive();
  }

  initGoogleDrive() {
    const { GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET, GOOGLE_DRIVE_REFRESH_TOKEN, GOOGLE_DRIVE_REDIRECT_URI } = process.env;
    
    if (!GOOGLE_DRIVE_CLIENT_ID || !GOOGLE_DRIVE_CLIENT_SECRET || !GOOGLE_DRIVE_REFRESH_TOKEN) {
      throw new Error('Missing Google Drive OAuth2 credentials');
    }

    const oauth2Client = new google.auth.OAuth2(
      GOOGLE_DRIVE_CLIENT_ID,
      GOOGLE_DRIVE_CLIENT_SECRET,
      GOOGLE_DRIVE_REDIRECT_URI || 'https://developers.google.com/oauthplayground'
    );

    // Set refresh token (access token will auto-refresh as needed)
    oauth2Client.setCredentials({ 
      refresh_token: GOOGLE_DRIVE_REFRESH_TOKEN,
      access_token: process.env.ACCESS_TOKEN,
    });

    // Keep a reference and listen for refreshed tokens
    this.oauth2Client = oauth2Client;
    this.oauth2Client.on('tokens', (tokens) => {
      if (tokens.access_token) {
        // update in-memory token so subsequent calls use fresh token
        this.oauth2Client.setCredentials({
          refresh_token: GOOGLE_DRIVE_REFRESH_TOKEN,
          access_token: tokens.access_token,
        });
      }
    });

    this.drive = google.drive({ version: 'v3', auth: this.oauth2Client });
  }

  async withAuthRetry(fn) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.code || err?.response?.status;
      if (status === 401 || status === 403) {
        // Force-get a fresh access token and retry once
        await this.oauth2Client.getAccessToken();
        return await fn();
      }
      throw err;
    }
  }

  async ensureDirectories() {
    await fs.ensureDir(this.tempDir);
    await fs.ensureDir(this.zipDir);
  }

  async getAllRepositories() {
    const repos = [];
    let page = 1;

    while (true) {
      const response = await this.octokit.repos.listForUser({
        username: this.githubUsername,
        per_page: 100,
        page,
        sort: 'updated',
      });

      repos.push(...response.data);
      if (response.data.length < 100) break;
      page++;
    }

    return repos;
  }

  async downloadRepository(repo, downloadPath) {
    const repoPath = path.join(downloadPath, repo.name);

    // Clean up existing directory if it exists
    if (await fs.pathExists(repoPath)) {
      await fs.remove(repoPath);
    }

    try {
      await simpleGit().clone(repo.clone_url, repoPath, ['--depth', '1']);
      return repoPath;
    } catch {
      const zipUrl = `https://github.com/${this.githubUsername}/${repo.name}/archive/refs/heads/${repo.default_branch || 'main'}.zip`;
      const zipPath = path.join(downloadPath, `${repo.name}.zip`);
      
      await this.downloadFile(zipUrl, zipPath);
      
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(downloadPath, true);
      await fs.remove(zipPath);
      
      const extractedPath = path.join(downloadPath, `${repo.name}-${repo.default_branch || 'main'}`);
      if (await fs.pathExists(extractedPath)) {
        await fs.move(extractedPath, repoPath);
      }
      
      return repoPath;
    }
  }

  downloadFile(url, filePath) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filePath);
      const options = {
        headers: {
          'Authorization': `token ${process.env.GITHUB_TOKEN}`,
          'User-Agent': 'Node.js',
        },
      };

      const handleResponse = (response) => {
        if ([301, 302].includes(response.statusCode)) {
          https.get(response.headers.location, options, handleResponse).on('error', reject);
        } else {
          response.pipe(file);
          file.on('finish', () => file.close(resolve));
        }
      };

      https.get(url, options, handleResponse).on('error', (err) => {
        fs.unlink(filePath, () => {});
        reject(err);
      });
    });
  }

  async createZipFile(repo, repoPath) {
    const zipFileName = `${repo.name}-${new Date().toISOString().split('T')[0]}.zip`;
    const zipFilePath = path.join(this.zipDir, zipFileName);

    return new Promise((resolve, reject) => {
      const archive = archiver('zip', { zlib: { level: 9 } });
      const output = fs.createWriteStream(zipFilePath);

      archive.pipe(output);
      archive.directory(repoPath, false);
      archive.on('error', reject);
      output.on('close', () => resolve(zipFilePath));
      archive.finalize();
    });
  }

  async uploadToGoogleDrive(filePath, fileName) {
    const requestBody = { name: fileName, mimeType: 'application/zip' };
    // if (process.env.GOOGLE_DRIVE_FOLDER_ID) {
    //   requestBody.parents = [process.env.GOOGLE_DRIVE_FOLDER_ID];
    // }

    const response = await this.withAuthRetry(() => this.drive.files.create({
      requestBody,
      media: {
        mimeType: 'application/zip',
        body: fs.createReadStream(filePath),
      },
      // fields: 'id, name, webViewLink, webContentLink',
    }));

    return response.data;
  }

  async deleteFileFromGoogleDrive(fileId) {
    await this.withAuthRetry(() => this.drive.files.delete({ fileId }));
  }

  async generatePublicUrl(fileId) {
    await this.withAuthRetry(() => this.drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' },
    }));

    const result = await this.withAuthRetry(() => this.drive.files.get({
      fileId,
      fields: 'webViewLink, webContentLink',
    }));

    return result.data;
  }

  async processRepository(repo) {
    const repoPath = await this.downloadRepository(repo, this.tempDir);
    const zipFilePath = await this.createZipFile(repo, repoPath);
    
    await this.uploadToGoogleDrive(zipFilePath, path.basename(zipFilePath));
    
    await fs.remove(repoPath);
    await fs.remove(zipFilePath);
  }

  async run() {
    await this.ensureDirectories();
    const repos = await this.getAllRepositories();
    
    for (const repo of repos) {
      await this.processRepository(repo);
    }

    await fs.emptyDir(this.tempDir);
    return { success: true, reposProcessed: repos.length };
  }
}

const app = express();
const PORT = process.env.PORT || 5000;
const service = new GitHubRepoZipService();

app.use(express.json());

let lastBackupStatus = {
  status: 'idle',
  lastRun: null,
  reposProcessed: 0,
  error: null,
};

app.get('/', (req, res) => {
  res.json({
    message: 'GitHub Repo Zip Microservice',
    status: 'running',
    endpoints: {
      health: '/health',
      status: '/status',
      trigger: '/trigger',
      repos: '/repos',
    },
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
  });
});

app.get('/status', (req, res) => {
  res.json({
    ...lastBackupStatus,
    timestamp: new Date().toISOString(),
  });
});

app.post('/trigger', async (req, res) => {
  if (lastBackupStatus.status === 'running') {
    return res.status(409).json({
      error: 'Backup already in progress',
      status: lastBackupStatus,
    });
  }

  lastBackupStatus = {
    status: 'running',
    lastRun: new Date().toISOString(),
    reposProcessed: 0,
    error: null,
  };

  try {
    const result = await service.run();
    lastBackupStatus = {
      status: 'completed',
      lastRun: new Date().toISOString(),
      reposProcessed: result.reposProcessed,
      error: null,
    };
    res.json({
      success: true,
      message: 'Backup completed successfully',
      ...lastBackupStatus,
    });
  } catch (error) {
    console.log("error:>>>", error);
    lastBackupStatus = {
      status: 'failed',
      lastRun: new Date().toISOString(),
      reposProcessed: 0,
      error: error.message,
    };
    res.status(500).json({
      success: false,
      message: 'Backup failed',
      ...lastBackupStatus,
    });
  }
});

app.get('/repos', async (req, res) => {
  try {
    const repos = await service.getAllRepositories();
    res.json({
      success: true,
      count: repos.length,
      repositories: repos.map((repo) => ({
        name: repo.name,
        fullName: repo.full_name,
        description: repo.description,
        url: repo.html_url,
        private: repo.private,
        updatedAt: repo.updated_at,
        defaultBranch: repo.default_branch,
      })),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

cron.schedule('0 * * * *', async () => {
  console.log('\n=== Cron job triggered at', new Date().toISOString(), '===');
  lastBackupStatus = {
    status: 'running',
    lastRun: new Date().toISOString(),
    reposProcessed: 0,
    error: null,
  };
  
  try {
    const result = await service.run();
    lastBackupStatus = {
      status: 'completed',
      lastRun: new Date().toISOString(),
      reposProcessed: result.reposProcessed,
      error: null,
    };
  } catch (error) {
    lastBackupStatus = {
      status: 'failed',
      lastRun: new Date().toISOString(),
      reposProcessed: 0,
      error: error.message,
    };
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`API endpoints available at http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Status: http://localhost:${PORT}/status`);
  console.log(`Trigger backup: POST http://localhost:${PORT}/trigger`);
  console.log(`List repos: http://localhost:${PORT}/repos`);
});


