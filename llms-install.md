# Gmail AutoAuth MCP Installation Guide

This guide will help you install and configure the Gmail AutoAuth MCP server for managing Gmail operations through Claude Desktop with auto authentication support.

## Requirements

- Node.js and npm installed
- Access to create a Google Cloud Project
- Local directory for configuration storage
- Web browser for OAuth authentication

## Installation Steps

1. First, create a Google Cloud Project and obtain the necessary credentials:
   ```
   1. Go to Google Cloud Console (https://console.cloud.google.com)
   2. Create a new project or select an existing one
   3. Enable the Gmail API for your project
   4. Create OAuth 2.0 credentials:
      - Go to "APIs & Services" > "Credentials"
      - Click "Create Credentials" > "OAuth client ID"
      - Choose "Desktop app" or "Web application" type
      - For Web application, add http://localhost:3000/oauth2callback to redirect URIs
      - Download the OAuth keys JSON file
      - Rename it to gcp-oauth.keys.json
   ```

2. Set up the configuration directory:
   ```bash
   mkdir -p ~/.gmail-mcp
   mv gcp-oauth.keys.json ~/.gmail-mcp/
   ```

3. Run authentication:
   ```bash
   npx @gongrzhe/server-gmail-autoauth-mcp auth
   ```
   This will:
   - Look for gcp-oauth.keys.json in current directory or ~/.gmail-mcp/
   - Copy it to ~/.gmail-mcp/ if found in current directory
   - Launch browser for Google authentication
   - Save credentials as ~/.gmail-mcp/credentials.json

4. Configure Claude Desktop by adding the MCP server configuration:
   ```json
   {
     "mcpServers": {
       "gmail": {
         "command": "npx",
         "args": [
           "@gongrzhe/server-gmail-autoauth-mcp"
         ]
       }
     }
   }
   ```

## Troubleshooting

If you encounter any issues during installation:

1. OAuth Keys Issues:
   - Verify gcp-oauth.keys.json exists in correct location
   - Check file permissions
   - Ensure keys contain valid web or installed credentials

2. Authentication Errors:
   - Confirm Gmail API is enabled
   - For web applications, verify redirect URI configuration
   - Check port 3000 is available during authentication

3. Configuration Issues:
   - Verify ~/.gmail-mcp directory exists and has correct permissions
   - Check credentials.json was created after authentication
   - Ensure Claude Desktop configuration is properly formatted

## Security Notes

- Store OAuth credentials securely in ~/.gmail-mcp/
- Never commit credentials to version control
- Use proper file permissions for config directory
- Regularly review access in Google Account settings
- Credentials are only accessible by current user

## Usage Examples

After installation, you can perform various Gmail operations:

### Send Email
```json
{
  "to": ["recipient@example.com"],
  "subject": "Meeting Tomorrow",
  "body": "Hi,\n\nJust a reminder about our meeting tomorrow at 10 AM.\n\nBest regards",
  "cc": ["cc@example.com"],
  "bcc": ["bcc@example.com"]
}
```

### Search Emails
```json
{
  "query": "from:sender@example.com after:2024/01/01",
  "maxResults": 10
}
```

### Manage Email
- Read emails by ID
- Move emails between labels
- Mark emails as read/unread
- Delete emails
- List emails in different folders

For more details or support, please check the GitHub repository or file an issue.