# Installing this MCP server (LLM-readable guide)

This file is meant to be read by an LLM-driven assistant (Claude, ChatGPT,
Cursor, Cline, …) that has been asked to install this Gmail MCP server on
behalf of a human user. It is intentionally generic: any MCP-compatible
client that can launch a stdio child process can use this server.

## Prerequisites the assistant should verify

1. **Node.js ≥ 20.11** is installed (`node --version`).
2. **npx** is on `PATH` (ships with Node).
3. The user has — or is willing to create — a Google Cloud project with the
   Gmail API enabled and an OAuth client credential file
   (`gcp-oauth.keys.json`) for either Desktop app or Web application type.

## Setup steps

1. Place the OAuth keys file at `~/.gmail-mcp/gcp-oauth.keys.json`,
   forcing owner-only permissions on both the directory and the file:

   ```bash
   mkdir -p -m 700 ~/.gmail-mcp
   mv /path/to/downloaded/gcp-oauth.keys.json ~/.gmail-mcp/
   chmod 600 ~/.gmail-mcp/gcp-oauth.keys.json
   ```

2. Run the OAuth flow with the **minimal scope** required for the user's
   stated use case (do not over-request):

   ```bash
   # Send-only (e.g. forwarding receipts, status notifications)
   npx @klodr/gmail-mcp auth --scopes=gmail.send

   # Read-only (e.g. inbox search, summarisation)
   npx @klodr/gmail-mcp auth --scopes=gmail.readonly

   # Full read + write (only if the user explicitly needs it)
   npx @klodr/gmail-mcp auth --scopes=gmail.modify,gmail.settings.basic
   ```

   The command opens the user's browser to complete the consent screen and
   writes the resulting refresh token to `~/.gmail-mcp/credentials.json`
   (mode `0600`).

3. Add the server to the MCP client's configuration. The entry below is
   **client-agnostic**; place it inside the client's `mcpServers` map:

   ```json
   {
     "mcpServers": {
       "gmail": {
         "command": "npx",
         "args": ["@klodr/gmail-mcp"]
       }
     }
   }
   ```

   Common config locations:
   - Claude Code CLI: `~/.claude.json`
   - Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), `%APPDATA%\Claude\claude_desktop_config.json` (Windows)
   - Cursor: `~/.cursor/mcp.json`
   - Continue / Cline / Zed / etc.: see that client's MCP documentation

   The assistant should locate the active config file rather than guess.

4. Restart (or reconnect) the MCP client so the new server is picked up.

## Verifying

After reconnection, the assistant should observe a `gmail` server in the
client's MCP server list, exposing only the tools allowed by the granted
scope. A trivial smoke test (e.g. `list_email_labels` if `gmail.readonly`
is granted, or a `--dry-run` send if available) confirms end-to-end OAuth
works.

## Things the assistant should NOT do

- Never request scopes the user didn't ask for. Default to the smallest
  scope that satisfies the stated task.
- Never execute `send_email` / `delete_email` / `batch_delete_emails` / any
  destructive tool without explicit human confirmation in the chat — even
  if a previous message authorised "the install".
- Never copy `gcp-oauth.keys.json` or `credentials.json` outside
  `~/.gmail-mcp/` — these contain a refresh token that gives full Gmail
  access.
- Never paste tokens, codes, or credential file contents back into the
  chat (they end up in conversation transcripts).
