# GitHub Repo Zip Microservice

This Node.js project automatically backs up all repositories from a GitHub account by creating zip files and uploading them to Google Drive. It runs a cron job every hour to keep your backups up-to-date.

## Features

- ✅ Automatically fetches all repositories from a GitHub account
- ✅ Creates zip files for each repository
- ✅ Uploads zip files to Google Drive
- ✅ Runs automatically every hour via cron job
- ✅ Handles both public and private repositories (with proper authentication)
- ✅ Express.js REST API for monitoring and manual triggers
- ✅ Health check and status endpoints

## Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- Git installed on your system (for cloning repositories)
- GitHub Personal Access Token
- Google Cloud Project with Drive API enabled
- Google Drive OAuth 2.0 credentials (Client ID, Client Secret, Refresh Token)

## Installation

1. Clone or download this repository
2. Install dependencies:
```bash
npm install
```

## Configuration

### 1. GitHub Setup

1. Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Generate a new token with the following scopes:
   - `repo` (Full control of private repositories)
   - `read:org` (if accessing organization repos)
3. Copy the token

### 2. Google Drive Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the Google Drive API:
   - Navigate to "APIs & Services" → "Library"
   - Search for "Google Drive API"
   - Click "Enable"
4. Create OAuth 2.0 Credentials:
   - Go to "APIs & Services" → "Credentials"
   - Click "Create Credentials" → "OAuth client ID"
   - If prompted, configure the OAuth consent screen first:
     - Choose "External" user type
     - Fill in the required information
     - Add scopes: `https://www.googleapis.com/auth/drive.file`
     - Add test users if needed (for testing)
   - Create OAuth client ID:
     - Application type: "Web application"
     - Name: Your application name
     - Authorized redirect URIs: `https://developers.google.com/oauthplayground`
     - Copy the Client ID and Client Secret
5. Generate Refresh Token:
   - Go to [OAuth 2.0 Playground](https://developers.google.com/oauthplayground)
   - Click the gear icon (⚙️) in the top right
   - Check "Use your own OAuth credentials"
   - Enter your Client ID and Client Secret
   - In the left panel, find "Drive API v3"
   - Select scope: `https://www.googleapis.com/auth/drive.file`
   - Click "Authorize APIs"
   - Sign in with your Google account and grant permissions
   - Click "Exchange authorization code for tokens"
   - Copy the "Refresh token" value
6. (Optional) Create a folder in Google Drive where you want to upload backups:
   - Create a folder in Google Drive
   - Copy the folder ID from the URL (e.g., `1ABC...xyz`)

### 3. Environment Variables

Create a `.env` file in the project root:

```env
# GitHub Configuration
GITHUB_TOKEN=your_github_personal_access_token
GITHUB_USERNAME=your_github_username

# Google Drive Configuration (OAuth2)
GOOGLE_DRIVE_CLIENT_ID=your_client_id
GOOGLE_DRIVE_CLIENT_SECRET=your_client_secret
GOOGLE_DRIVE_REFRESH_TOKEN=your_refresh_token
GOOGLE_DRIVE_REDIRECT_URI=https://developers.google.com/oauthplayground
GOOGLE_DRIVE_FOLDER_ID=your_google_drive_folder_id_optional

# Server Configuration (optional)
PORT=3000
```

Replace the values with your actual credentials.

## Usage

### Run the service:

```bash
npm start
```

The service will:
1. Start an Express.js server (default port 3000)
2. Schedule a cron job to run every hour (at minute 0 of each hour)
3. Provide REST API endpoints for monitoring and control

### API Endpoints

The service exposes the following REST API endpoints:

#### `GET /`
Get API information and available endpoints.

**Response:**
```json
{
  "message": "GitHub Repo Zip Microservice",
  "status": "running",
  "endpoints": {
    "health": "/health",
    "status": "/status",
    "trigger": "/trigger",
    "repos": "/repos"
  }
}
```

#### `GET /health`
Health check endpoint.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

#### `GET /status`
Get the status of the last backup operation.

**Response:**
```json
{
  "status": "completed",
  "lastRun": "2024-01-01T12:00:00.000Z",
  "reposProcessed": 10,
  "error": null,
  "timestamp": "2024-01-01T12:05:00.000Z"
}
```

#### `POST /trigger`
Manually trigger a backup operation.

**Response:**
```json
{
  "success": true,
  "message": "Backup completed successfully",
  "status": "completed",
  "lastRun": "2024-01-01T12:00:00.000Z",
  "reposProcessed": 10,
  "error": null
}
```

#### `GET /repos`
Get a list of all repositories from the GitHub account.

**Response:**
```json
{
  "success": true,
  "count": 10,
  "repositories": [
    {
      "name": "repo-name",
      "fullName": "username/repo-name",
      "description": "Repo description",
      "url": "https://github.com/username/repo-name",
      "private": false,
      "updatedAt": "2024-01-01T12:00:00Z",
      "defaultBranch": "main"
    }
  ]
}
```

### Example API Usage

```bash
# Check health
curl http://localhost:3000/health

# Get status
curl http://localhost:3000/status

# Trigger manual backup
curl -X POST http://localhost:3000/trigger

# List repositories
curl http://localhost:3000/repos
```

## How It Works

1. **Repository Fetching**: Uses GitHub API to fetch all repositories for the specified user
2. **Repository Download**: 
   - First attempts to clone repositories using Git (shallow clone for efficiency)
   - Falls back to downloading as zip if Git is unavailable
3. **Zip Creation**: Creates compressed zip files for each repository with date stamps
4. **Google Drive Upload**: Uploads each zip file to your Google Drive
5. **Cleanup**: Removes temporary files and directories after upload

## Project Structure

```
.
├── index.js              # Main application file
├── package.json          # Dependencies and scripts
├── .env                  # Environment variables (create this)
├── temp/                 # Temporary directory for downloads (auto-created)
├── zips/                 # Temporary directory for zip files (auto-created)
└── README.md            # This file
```

## Cron Schedule

The cron job runs every hour at minute 0. The cron expression is: `0 * * * *`

To change the schedule, modify the cron expression in `index.js`:
```javascript
cron.schedule('0 * * * *', () => {
  // Your code here
});
```

Common cron patterns:
- `0 * * * *` - Every hour
- `0 */2 * * *` - Every 2 hours
- `0 0 * * *` - Every day at midnight
- `*/30 * * * *` - Every 30 minutes

## Troubleshooting

### Error: "Git clone failed"
- Ensure Git is installed and accessible from command line
- The script will automatically fall back to downloading zip files

### Error: "Google Drive initialization failed"
- Verify that `credentials.json` exists and is valid
- Ensure the Google Drive API is enabled in your Google Cloud project
- Check that the service account has proper permissions

### Error: "GitHub API rate limit exceeded"
- GitHub API has rate limits for authenticated requests (5,000/hour)
- If you have many repositories, consider adding delays between requests

### Error: "Folder not found in Google Drive"
- If using `GOOGLE_DRIVE_FOLDER_ID`, ensure the folder is shared with your service account email
- The service account email can be found in `credentials.json` under `client_email`

## Security Notes

- Never commit `.env` or `credentials.json` to version control
- Keep your GitHub token secure
- The `.gitignore` file includes these sensitive files
- Consider using environment-specific credential files for production

## License

MIT
