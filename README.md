# Gmail AutoAuth MCP Server

A Model Context Protocol (MCP) server for Gmail integration in Claude Desktop with auto authentication support. This server enables AI assistants to manage Gmail through natural language interactions.

![](https://badge.mcpx.dev?type=server 'MCP Server')
[![smithery badge](https://smithery.ai/badge/@gongrzhe/server-gmail-autoauth-mcp)](https://smithery.ai/server/@gongrzhe/server-gmail-autoauth-mcp)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)


## Features

- Send emails with subject, content, attachments, and recipients
- Full support for international characters in subject lines and email content
- Read email messages by ID with advanced MIME structure handling
- View email attachments information (filenames, types, sizes)
- Search emails with various criteria (subject, sender, date range)
- List all available Gmail labels (system and user-defined)
- List emails in inbox, sent, or custom labels
- Mark emails as read/unread
- Move emails to different labels/folders
- Delete emails
- Full integration with Gmail API
- Simple OAuth2 authentication flow with auto browser launch
- Support for both Desktop and Web application credentials
- Global credential storage for convenience

## Installation & Authentication

### Installing via Smithery

To install Gmail AutoAuth for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@gongrzhe/server-gmail-autoauth-mcp):

```bash
npx -y @smithery/cli install @gongrzhe/server-gmail-autoauth-mcp --client claude
```

### Installing Manually
1. Create a Google Cloud Project and obtain credentials:

   a. Create a Google Cloud Project:
      - Go to [Google Cloud Console](https://console.cloud.google.com/)
      - Create a new project or select an existing one
      - Enable the Gmail API for your project

   b. Create OAuth 2.0 Credentials:
      - Go to "APIs & Services" > "Credentials"
      - Click "Create Credentials" > "OAuth client ID"
      - Choose either "Desktop app" or "Web application" as application type
      - Give it a name and click "Create"
      - For Web application, add `http://localhost:3000/oauth2callback` to the authorized redirect URIs
      - Download the JSON file of your client's OAuth keys
      - Rename the key file to `gcp-oauth.keys.json`

2. Run Authentication:

   You can authenticate in two ways:

   a. Global Authentication (Recommended):
   ```bash
   # First time: Place gcp-oauth.keys.json in your home directory's .gmail-mcp folder
   mkdir -p ~/.gmail-mcp
   mv gcp-oauth.keys.json ~/.gmail-mcp/

   # Run authentication from anywhere
   npx @gongrzhe/server-gmail-autoauth-mcp auth
   ```

   b. Local Authentication:
   ```bash
   # Place gcp-oauth.keys.json in your current directory
   # The file will be automatically copied to global config
   npx @gongrzhe/server-gmail-autoauth-mcp auth
   ```

   The authentication process will:
   - Look for `gcp-oauth.keys.json` in the current directory or `~/.gmail-mcp/`
   - If found in current directory, copy it to `~/.gmail-mcp/`
   - Open your default browser for Google authentication
   - Save credentials as `~/.gmail-mcp/credentials.json`

   > **Note**: 
   > - After successful authentication, credentials are stored globally in `~/.gmail-mcp/` and can be used from any directory
   > - Both Desktop app and Web application credentials are supported
   > - For Web application credentials, make sure to add `http://localhost:3000/oauth2callback` to your authorized redirect URIs

3. Configure in Claude Desktop:

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

### Docker Support

If you prefer using Docker:

1. Authentication:
```bash
docker run -i --rm \
  --mount type=bind,source=/path/to/gcp-oauth.keys.json,target=/gcp-oauth.keys.json \
  -v mcp-gmail:/gmail-server \
  -e GMAIL_OAUTH_PATH=/gcp-oauth.keys.json \
  -e "GMAIL_CREDENTIALS_PATH=/gmail-server/credentials.json" \
  -p 3000:3000 \
  mcp/gmail auth
```

2. Usage:
```json
{
  "mcpServers": {
    "gmail": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-v",
        "mcp-gmail:/gmail-server",
        "-e",
        "GMAIL_CREDENTIALS_PATH=/gmail-server/credentials.json",
        "mcp/gmail"
      ]
    }
  }
}
```

## Available Tools

The server provides the following tools that can be used through Claude Desktop:

### 1. Send Email (`send_email`)
Sends a new email immediately.

```json
{
  "to": ["recipient@example.com"],
  "subject": "Meeting Tomorrow",
  "body": "Hi,\n\nJust a reminder about our meeting tomorrow at 10 AM.\n\nBest regards",
  "cc": ["cc@example.com"],
  "bcc": ["bcc@example.com"]
}
```

### 2. Draft Email (`draft_email`)
Creates a draft email without sending it.

```json
{
  "to": ["recipient@example.com"],
  "subject": "Draft Report",
  "body": "Here's the draft report for your review.",
  "cc": ["manager@example.com"]
}
```

### 3. Read Email (`read_email`)
Retrieves the content of a specific email by its ID.

```json
{
  "messageId": "182ab45cd67ef"
}
```

### 4. Search Emails (`search_emails`)
Searches for emails using Gmail search syntax.

```json
{
  "query": "from:sender@example.com after:2024/01/01 has:attachment",
  "maxResults": 10
}
```

### 5. Modify Email (`modify_email`)
Moves emails to different labels/folders.

```json
{
  "messageId": "182ab45cd67ef",
  "labelIds": ["INBOX", "IMPORTANT"]
}
```

### 6. Delete Email (`delete_email`)
Permanently deletes an email.

```json
{
  "messageId": "182ab45cd67ef"
}
```

### 7. List Email Labels (`list_email_labels`)
Retrieves all available Gmail labels.

```json
{}
```

## Advanced Search Syntax

The `search_emails` tool supports Gmail's powerful search operators:

| Operator | Example | Description |
|----------|---------|-------------|
| `from:` | `from:john@example.com` | Emails from a specific sender |
| `to:` | `to:mary@example.com` | Emails sent to a specific recipient |
| `subject:` | `subject:"meeting notes"` | Emails with specific text in the subject |
| `has:attachment` | `has:attachment` | Emails with attachments |
| `after:` | `after:2024/01/01` | Emails received after a date |
| `before:` | `before:2024/02/01` | Emails received before a date |
| `is:` | `is:unread` | Emails with a specific state |
| `label:` | `label:work` | Emails with a specific label |

You can combine multiple operators: `from:john@example.com after:2024/01/01 has:attachment`

## Advanced Features

### Email Content Extraction

The server intelligently extracts email content from complex MIME structures:

- Prioritizes plain text content when available
- Falls back to HTML content if plain text is not available
- Handles multi-part MIME messages with nested parts
- Processes attachments information (filename, type, size)
- Preserves original email headers (From, To, Subject, Date)

### International Character Support

The server fully supports non-ASCII characters in email subjects and content, including:
- Turkish, Chinese, Japanese, Korean, and other non-Latin alphabets
- Special characters and symbols
- Proper encoding ensures correct display in email clients


## Security Notes

- OAuth credentials are stored securely in your local environment (`~/.gmail-mcp/`)
- The server uses offline access to maintain persistent authentication
- Never share or commit your credentials to version control
- Regularly review and revoke unused access in your Google Account settings
- Credentials are stored globally but are only accessible by the current user

## Troubleshooting

1. **OAuth Keys Not Found**
   - Make sure `gcp-oauth.keys.json` is in either your current directory or `~/.gmail-mcp/`
   - Check file permissions

2. **Invalid Credentials Format**
   - Ensure your OAuth keys file contains either `web` or `installed` credentials
   - For web applications, verify the redirect URI is correctly configured

3. **Port Already in Use**
   - If port 3000 is already in use, please free it up before running authentication
   - You can find and stop the process using that port

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the ISC License.

## Support

If you encounter any issues or have questions, please file an issue on the GitHub repository.
