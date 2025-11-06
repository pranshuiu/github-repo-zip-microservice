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
    this.accessTokenFile = path.join(__dirname, 'access_token.txt');
    
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

    // Load access token from file only
    const savedAccessToken = this.readAccessTokenFromFile();

    // Set refresh token (access token will auto-refresh as needed)
    oauth2Client.setCredentials({ 
      refresh_token: GOOGLE_DRIVE_REFRESH_TOKEN,
      access_token: savedAccessToken || undefined,
    });

    // Keep a reference and listen for refreshed tokens
    this.oauth2Client = oauth2Client;
    this.oauth2Client.on('tokens', (tokens) => {
      if (tokens.access_token) {
        // Update in-memory token and save to file
        this.oauth2Client.setCredentials({
          refresh_token: GOOGLE_DRIVE_REFRESH_TOKEN,
          access_token: tokens.access_token,
        });
        this.saveAccessTokenToFile(tokens.access_token);
      }
    });

    this.drive = google.drive({ version: 'v3', auth: this.oauth2Client });
    this.refreshToken = GOOGLE_DRIVE_REFRESH_TOKEN;
  }

  readAccessTokenFromFile() {
    try {
      if (fs.existsSync(this.accessTokenFile)) {
        const token = fs.readFileSync(this.accessTokenFile, 'utf8').trim();
        return token || null;
      }
    } catch (error) {
      console.error('Error reading access token from file:', error.message);
    }
    return null;
  }

  saveAccessTokenToFile(accessToken) {
    try {
      fs.writeFileSync(this.accessTokenFile, accessToken, 'utf8');
      console.log('Access token saved to file');
    } catch (error) {
      console.error('Error saving access token to file:', error.message);
    }
  }

  async validateAccessToken() {
    try {
      // Try to make a simple API call to validate the token
      await this.drive.files.list({
        pageSize: 1,
        fields: 'files(id)',
      });
      return true;
    } catch (error) {
      const status = error?.code || error?.response?.status;
      if (status === 401 || status === 403) {
        return false;
      }
      // For other errors, assume token might be valid (network issues, etc.)
      return true;
    }
  }

  async ensureValidAccessToken() {
    const isValid = await this.validateAccessToken();
    if (!isValid) {
      console.log('Access token is invalid, refreshing...');
      try {
        // getAccessToken() will automatically refresh the token if needed
        const accessToken = await this.oauth2Client.getAccessToken();
        if (accessToken) {
          // The token is already set in the client, but we save it to file
          // The 'tokens' event listener will also save it, but this ensures it's saved immediately
          const tokenString = typeof accessToken === 'string' ? accessToken : accessToken.token || accessToken;
          this.saveAccessTokenToFile(tokenString);
          console.log('Access token refreshed successfully');
        }
      } catch (error) {
        console.error('Error refreshing access token:', error.message);
        throw new Error('Failed to refresh access token');
      }
    } else {
      console.log('Access token is valid');
    }
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
      // Use listForAuthenticatedUser to get both public and private repos
      const response = await this.octokit.repos.listForAuthenticatedUser({
        per_page: 100,
        page,
        sort: 'updated',
        affiliation: 'owner', // Only get repos owned by the authenticated user
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
      // For private repos, use authenticated clone URL
      let cloneUrl = repo.clone_url;
      if (repo.private) {
        // Insert token into URL for authentication
        const token = process.env.GITHUB_TOKEN;
        cloneUrl = repo.clone_url.replace('https://', `https://${token}@`);
      }
      
      await simpleGit().clone(cloneUrl, repoPath, ['--depth', '1']);
      return repoPath;
    } catch {
      // Fallback to zip download - use repo owner from full_name for private repos
      const repoOwner = repo.full_name ? repo.full_name.split('/')[0] : this.githubUsername;
      const zipUrl = `https://github.com/${repoOwner}/${repo.name}/archive/refs/heads/${repo.default_branch || 'main'}.zip`;
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

  async listBackupFiles() {
    try {
      let allFiles = [];
      let pageToken = null;

      do {
        const response = await this.withAuthRetry(() => this.drive.files.list({
          q: "mimeType='application/zip' and trashed=false",
          fields: 'nextPageToken, files(id, name, createdTime, modifiedTime)',
          pageSize: 1000,
          pageToken: pageToken,
          orderBy: 'modifiedTime desc',
        }));

        if (response.data.files) {
          allFiles.push(...response.data.files);
        }
        pageToken = response.data.nextPageToken;
      } while (pageToken);

      return allFiles;
    } catch (error) {
      console.error('Error listing backup files:', error.message);
      throw error;
    }
  }

  async cleanupOldBackups() {
    try {
      console.log('Starting cleanup of old backup files...');
      const files = await this.listBackupFiles();
      
      if (files.length === 0) {
        console.log('No backup files found in Google Drive');
        return { deleted: 0, kept: 0 };
      }

      const now = new Date();
      const twoDaysAgo = new Date(now.getTime() - (2 * 24 * 60 * 60 * 1000)); // 2 days ago
      
      let deleted = 0;
      let kept = 0;
      const errors = [];

      for (const file of files) {
        try {
          // Use modifiedTime if available, otherwise use createdTime
          const fileDate = file.modifiedTime ? new Date(file.modifiedTime) : new Date(file.createdTime);
          
          if (fileDate < twoDaysAgo) {
            await this.deleteFileFromGoogleDrive(file.id);
            console.log(`Deleted old backup: ${file.name} (${fileDate.toISOString().split('T')[0]})`);
            deleted++;
          } else {
            kept++;
          }
        } catch (error) {
          console.error(`Error deleting file ${file.name}:`, error.message);
          errors.push({ file: file.name, error: error.message });
        }
      }

      console.log(`Cleanup completed: ${deleted} files deleted, ${kept} files kept`);
      if (errors.length > 0) {
        console.warn(`Failed to delete ${errors.length} files`);
      }

      return { deleted, kept, errors };
    } catch (error) {
      console.error('Error during cleanup:', error.message);
      throw error;
    }
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
    // Validate and refresh access token before running
    await this.ensureValidAccessToken();
    
    await this.ensureDirectories();
    const repos = await this.getAllRepositories();
    
    for (const repo of repos) {
      await this.processRepository(repo);
    }

    // Cleanup old backups (older than 2 days)
    const cleanupResult = await this.cleanupOldBackups();

    await fs.emptyDir(this.tempDir);
    return { 
      success: true, 
      reposProcessed: repos.length,
      cleanup: cleanupResult 
    };
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


