# HQ Gmail MCP — setup and usage guide

**Living doc for Headquarters Health.**  
Use this with **Cursor** (to install) and **Claude** (to send/read Gmail).  
Repo: [github.com/Headquarters-Health/gmail-mcp](https://github.com/Headquarters-Health/gmail-mcp)

Last updated: 2026-05-26

---

## What this does (plain English)

This tool lets an AI assistant **read, search, draft, and send email** from your Gmail account — from chat, not by clicking around Gmail.

Typical uses:

- “Search my outreach-2 inbox for threads I haven't replied to from last week”
- “Draft a follow-up to john@company.com from outreach-1”
- “Send this email **after I approve the draft**”

It runs **on your Mac** (not in the cloud). Your Google login is stored locally in hidden folders under your home directory.

---

## What works where

| App | Works with this MCP? | Notes |
|-----|----------------------|-------|
| **Claude Desktop** | ✅ Yes (recommended) | Local setup, full send/read |
| **Claude Code / Claude in Cursor** | ✅ Yes | Same config as Cursor |
| **Cursor Agent** | ✅ Yes | Great for initial install |
| **ChatGPT (web/app)** | ⚠️ Limited | Does **not** run local MCP like Claude. See [ChatGPT section](#chatgpt-important) |

**Bottom line:** set this up for **Claude**. Use ChatGPT for other tasks, or ask IT if you need a hosted connector later.

---

## Before you start

You need:

1. **A Mac** (these instructions are written for macOS)
2. **Cursor** installed ([cursor.com](https://cursor.com))
3. **Claude Desktop** installed ([claude.ai/download](https://claude.ai/download)) — free or paid
4. **Node.js 22+** — Cursor can install this for you (see Step 1)
5. **Access to Google Cloud Console** (or ask an admin for one shared OAuth file)
6. **The Gmail account(s)** you will connect (e.g. four outreach inboxes)

You do **not** need to write code. Paste the prompts below into **Cursor Chat**.

---

## Quick path (one Gmail account)

If you only need **one** inbox, follow Steps 1–5 and use the **single-account** config in Step 4.

If you need **four outreach accounts**, use the **four-account** config in Step 4 and repeat Step 3 four times.

---

## Step 1 — Install prerequisites (use Cursor)

1. Open **Cursor**.
2. Open the folder where you want the project (e.g. `~/Projects`).
3. Open **Cursor Chat** and paste:

```text
Help me set up HQ Gmail MCP on my Mac.

1. Check if Node.js is installed (need v22.22.2 or newer). If not, install it with Homebrew or nvm.
2. Clone https://github.com/Headquarters-Health/gmail-mcp into ~/Projects/gmail-mcp
3. Run npm ci && npm run build in that folder
4. Tell me the absolute path to dist/index.js when done
```

Wait until Cursor confirms the build succeeded.

---

## Step 2 — Google Cloud OAuth (one-time)

Someone on the team (often an admin) creates **one** Google Cloud OAuth app. Everyone can reuse the same `gcp-oauth.keys.json` file; each person still logs into **their own** Gmail separately.

### Admin checklist (Google Cloud Console)

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create or pick a project
3. **APIs & Services → Library** → enable **Gmail API**
4. **APIs & Services → OAuth consent screen**
   - User type: **External** (or Internal if Workspace)
   - Add every Gmail address people will connect as **Test users**
5. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Type: **Desktop app** (simplest)
   - Download JSON → rename to `gcp-oauth.keys.json`

Share that file securely (1Password, admin — **never** commit it to Git).

### Non-technical: get the file onto your Mac

Ask Cursor:

```text
I have gcp-oauth.keys.json in my Downloads folder. Create ~/.gmail-outreach-1/ (or ~/.gmail-mcp/ for a single account), copy the file there as gcp-oauth.keys.json, and set permissions so only I can read it (chmod 700 on the folder, chmod 600 on the file).
```

For **four accounts**, copy the **same** OAuth file into each folder:

- `~/.gmail-outreach-1/gcp-oauth.keys.json`
- `~/.gmail-outreach-2/gcp-oauth.keys.json`
- `~/.gmail-outreach-3/gcp-oauth.keys.json`
- `~/.gmail-outreach-4/gcp-oauth.keys.json`

---

## Step 3 — Sign in to Gmail (once per account)

Each Gmail inbox needs its **own** login. A browser window will open.

Ask Cursor (change the number for each account):

```text
Run Gmail MCP auth for outreach account 1:
- GMAIL_OAUTH_PATH=~/.gmail-outreach-1/gcp-oauth.keys.json
- GMAIL_CREDENTIALS_PATH=~/.gmail-outreach-1/credentials.json
- Command: node ~/Projects/gmail-mcp/dist/index.js auth --scopes=gmail.readonly,gmail.send,gmail.compose
Open the browser when prompted and sign in with the correct Gmail account.
```

Repeat for `outreach-2`, `outreach-3`, `outreach-4` with matching paths.

**Scopes explained:** read + send + compose only (not full delete/admin unless you need it).

---

## Step 4 — Connect Claude and Cursor

### Single account

Ask Cursor to merge this into your config files (it will fix paths for your username):

**Cursor** — `~/.cursor/mcp.json`  
**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Claude Code** — `~/.claude.json`

```json
{
  "mcpServers": {
    "gmail": {
      "command": "node",
      "args": ["/Users/YOUR_NAME/Projects/gmail-mcp/dist/index.js"],
      "env": {
        "GMAIL_OAUTH_PATH": "/Users/YOUR_NAME/.gmail-mcp/gcp-oauth.keys.json",
        "GMAIL_CREDENTIALS_PATH": "/Users/YOUR_NAME/.gmail-mcp/credentials.json"
      }
    }
  }
}
```

Replace `YOUR_NAME` with your Mac username (Cursor can do this automatically).

### Four outreach accounts

Use the template in the repo: [`config/mcp-outreach.example.json`](../config/mcp-outreach.example.json)

Ask Cursor:

```text
Open config/mcp-outreach.example.json in the gmail-mcp repo, replace /Users/User1 with my home directory path, and merge all four gmail-outreach-* servers into:
- ~/.cursor/mcp.json
- ~/Library/Application Support/Claude/claude_desktop_config.json
- ~/.claude.json
Do not delete my existing MCP servers — merge them.
```

### Restart apps

- **Quit Claude Desktop completely** (Cmd+Q), then reopen
- **Reload Cursor** (or restart) so MCP picks up changes

In Claude, you should see tools like `gmail-outreach-1`, `gmail-outreach-2`, etc. (or `gmail` for single account).

---

## Step 5 — Verify it works

In **Claude Desktop**, try:

```text
Using gmail-outreach-1 (or gmail if single account), list my email labels to confirm the connection works.
```

Then:

```text
Search gmail-outreach-1 for unread emails from the last 3 days. Summarize them — do not send anything.
```

If that works, setup is complete.

---

## Daily usage (copy-paste prompts)

Always **name which account** to use when you have multiple inboxes.

### Search / read

```text
Search gmail-outreach-2 for emails from @acme.com in the last 14 days that I haven't replied to.
```

```text
Read the full thread for the most recent result and summarize what they asked for.
```

### Draft (safe — nothing sent yet)

```text
Draft a short follow-up from gmail-outreach-1 to jane@example.com. Subject: "Following up". Keep it under 100 words. Show me the draft — do not send.
```

### Send (only after you review)

```text
Send the draft you just showed me from gmail-outreach-1. Confirm recipient and subject before sending.
```

### Reply in thread

```text
Reply-all on gmail-outreach-3 to the thread about "partnership" — say we're open to a call next week. Show draft first.
```

---

## Safety rules (everyone must follow)

1. **Never** paste OAuth files or `credentials.json` into chat, email, or GitHub.
2. **Always review** before send — say “show draft first” or “do not send until I approve”.
3. **Pick the right account** — say `gmail-outreach-2` explicitly so mail sends from the correct inbox.
4. **Cold outreach limits** — Gmail caps sends (~500/day on free Gmail). Spread volume; don’t blast identical copy from all four accounts at once.
5. **Revoke access** if a laptop is lost: [Google Account permissions](https://myaccount.google.com/permissions)

---

## ChatGPT (important)

ChatGPT **cannot** use this local MCP server the same way Claude does.

| Option | Recommendation |
|--------|----------------|
| Use **Claude Desktop** with this MCP | ✅ Do this |
| ChatGPT’s built-in Gmail connector | ❌ Does not support the same send workflow |
| Expose your Mac to the internet (ngrok, etc.) | ❌ Do not — exposes Gmail tokens |

If your team **must** use ChatGPT with Gmail, that requires a **separate IT project** (hosted MCP gateway with auth). This doc does not cover that. For now, use **Claude for Gmail** and ChatGPT for everything else.

---

## Troubleshooting

### “MCP server failed to start”

Ask Cursor:

```text
Diagnose my Gmail MCP setup: check Node version, that ~/Projects/gmail-mcp/dist/index.js exists, and that paths in ~/.cursor/mcp.json are absolute and correct.
```

### “403 access_denied” during Google login

Your email is not on the OAuth app’s **Test users** list. Ask an admin to add it in Google Cloud Console → OAuth consent screen → Test users.

### “Authentication failed” / token expired

Re-run Step 3 auth for that account:

```text
Re-authenticate gmail-outreach-1 using node ~/Projects/gmail-mcp/dist/index.js auth with the same env paths as before.
```

### Claude doesn’t show Gmail tools

1. Confirm config file path (Step 4)
2. Fully quit and reopen Claude Desktop
3. Check JSON is valid (no trailing commas) — Cursor can validate

### Wrong account sent email

You forgot to specify the MCP server name. Always say `gmail-outreach-N` in the prompt.

---

## Updating the server (when HQ ships fixes)

Non-technical users: ask Cursor:

```text
In ~/Projects/gmail-mcp on branch main, run git pull, npm ci, npm run build, and tell me if I need to restart Claude.
```

Maintainers sync from upstream klodr:

```bash
cd ~/Projects/gmail-mcp
./scripts/sync-upstream.sh
npm ci && npm run build
```

---

## Cursor cheat sheet (for helpers)

Paste this when helping a teammate:

```text
You are helping a non-technical HQ teammate set up Gmail MCP from Headquarters-Health/gmail-mcp.

Rules:
- Use absolute paths on their Mac
- Never commit gcp-oauth.keys.json or credentials.json
- Merge MCP config, don't overwrite unrelated servers
- Use scopes: gmail.readonly,gmail.send,gmail.compose unless they need label/delete tools
- After config changes, tell them to restart Claude Desktop
- Prefer Claude Desktop for Gmail; explain ChatGPT limitations if asked

Repo path: ~/Projects/gmail-mcp
Example multi-account config: config/mcp-outreach.example.json
```

---

## Who to ask for help

1. **Setup broken?** — Paste the error into Cursor with this doc open
2. **Google Cloud / test users?** — Your team admin
3. **Repo bugs?** — [GitHub Issues](https://github.com/Headquarters-Health/gmail-mcp/issues) (internal owners TBD)

---

## File locations reference

| What | Where |
|------|--------|
| HQ fork (clone here) | `~/Projects/gmail-mcp` |
| Built server | `~/Projects/gmail-mcp/dist/index.js` |
| OAuth client keys (shared file) | `~/.gmail-outreach-N/gcp-oauth.keys.json` |
| Your login token (private) | `~/.gmail-outreach-N/credentials.json` |
| Cursor MCP config | `~/.cursor/mcp.json` |
| Claude Desktop MCP config | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Code MCP config | `~/.claude.json` |

**Never** share `credentials.json` — it is as sensitive as a password.
