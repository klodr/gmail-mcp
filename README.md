# 📧 gmail-mcp

> Read, search, send, draft, label, filter, and thread Gmail from any MCP-enabled AI assistant. Wraps the [Gmail API](https://developers.google.com/gmail/api) with scope-gated tools and in-process safeguards.

[![CI](https://github.com/klodr/gmail-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/klodr/gmail-mcp/actions/workflows/ci.yml)
[![CodeQL](https://github.com/klodr/gmail-mcp/actions/workflows/codeql.yml/badge.svg)](https://github.com/klodr/gmail-mcp/actions/workflows/codeql.yml)
[![Tested with Vitest](https://img.shields.io/badge/tested%20with-vitest-yellow?logo=vitest&labelColor=black)](https://vitest.dev)
[![codecov](https://codecov.io/gh/klodr/gmail-mcp/branch/main/graph/badge.svg)](https://codecov.io/gh/klodr/gmail-mcp)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/klodr/gmail-mcp/badge)](https://scorecard.dev/viewer/?uri=github.com/klodr/gmail-mcp)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/12613/badge)](https://www.bestpractices.dev/projects/12613)
[![Socket Security](https://socket.dev/api/badge/npm/package/@klodr/gmail-mcp)](https://socket.dev/npm/package/@klodr/gmail-mcp)
[![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/klodr/gmail-mcp?labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews)](https://coderabbit.ai)

[![npm version](https://img.shields.io/npm/v/@klodr/gmail-mcp.svg)](https://www.npmjs.com/package/@klodr/gmail-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@klodr/gmail-mcp.svg)](https://www.npmjs.com/package/@klodr/gmail-mcp)
[![Node.js Version](https://img.shields.io/node/v/@klodr/gmail-mcp.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-1.29-blue)](https://modelcontextprotocol.io)
[![MCP Server](https://badge.mcpx.dev?type=server 'MCP Server')](https://modelcontextprotocol.io)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/klodr/gmail-mcp/pulls)

[![Sponsor on GitHub](https://img.shields.io/github/sponsors/klodr?logo=github-sponsors&label=GitHub%20Sponsors&color=EA4AAA)](https://github.com/sponsors/klodr)
[![Patreon](https://img.shields.io/badge/Patreon-F96854?logo=patreon&logoColor=white)](https://www.patreon.com/klodr)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-FF5E5B?logo=kofi&logoColor=white)](https://ko-fi.com/klodr)

> [!NOTE]
> Hardened + enhanced fork of [GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server) (archived 2026-03-03), via [ArtyMcLabin/Gmail-MCP-Server](https://github.com/ArtyMcLabin/Gmail-MCP-Server). Since the divergence point: **180+ commits** and an extensive rewrite — security hardening, Gmail-surface improvements (reply-all, send-as alias, thread-level tools, download-to-disk, recipient pairing, batch ops with retry…), supply-chain hygiene, and CI gating. Every PR goes through CodeRabbit + dual-model Qodo Merge before merge. See [SECURITY.md](.github/SECURITY.md) for the controls and threat model, and the [comparison table](#-why-this-mcp) below for the parent-forks delta.

A Model Context Protocol (MCP) server that lets AI assistants (Claude Desktop, Claude Code, Cursor, Continue, OpenClaw…) read and manage a Gmail account through scope-gated tools. Exposes the Gmail v1 API surface you actually need (messages, threads, labels, filters, attachments, drafts, reply-all) behind a single `npx` install.

> [!IMPORTANT]
> **Positioning.** Upstream calls this fork the *maximalist* one. The label is accurate from the outside, but it misframes the intent. `klodr/gmail-mcp` is built around four properties — and the code, tests and CI/CD all exist to pay rent on these and only these:
>
> - **Secure** — input sanitization, recipient pairing, rate limiting, sender resolution, and audit logging are enforced *in the server* (not in the operator's attention). The Gmail surface is mediated, not exposed raw.
> - **Autonomous** — designed to stay safe when no human is watching every action. Different threat model from upstream's "I use it daily in my own workflow"; the in-process middleware is what bridges that gap.
> - **Tested** — 945 vitest cases across 43 files, **99.37%** statement coverage (91% branch), plus a fast-check property-based fuzz suite and a dedicated hardening test file.
> - **Resilient under acceleration** — 17 CI/CD workflows (CodeQL, OSV, Gitleaks, leak-detect, Scorecard, Socket, SLSA, lockfile lint, signed releases…) track the security ecosystem at the pace it actually changes — days, sometimes hours. Recent concrete instance: **qs CVE-2026-8723**, surfaced and shipped within hours of the public advisory across the klodr/* MCP family.
>
> Full rationale and the per-tool design trade-offs live in [`docs/DESIGN_DECISIONS.md`](docs/DESIGN_DECISIONS.md).

## ✨ Why this MCP?

Comparison of the three maintained forks of the original Gmail MCP server, focusing on what an agent platform actually needs — prompt-injection safety, supply-chain integrity, and operational hygiene:

| Capability | [GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server) (original, unmaintained) | [ArtyMcLabin/Gmail-MCP-Server](https://github.com/ArtyMcLabin/Gmail-MCP-Server) (intermediate fork) | **klodr/gmail-mcp** (this repo) |
|---|:---:|:---:|:---:|
| **Core Gmail surface** | | | |
| Send / draft / read / search messages | ✅ | ✅ | ✅ |
| Label CRUD | ✅ | ✅ | ✅ |
| Filter CRUD | ⚠️ `list_filters` broken | ✅ fixed | ✅ |
| Batch modify / delete | ✅ | ✅ | ✅ |
| Reply threading (`In-Reply-To` / `References`) | ❌ orphaned replies | ✅ | ✅ |
| Reply-all tool | ❌ | ✅ | ✅ |
| Send-as alias (`from` parameter) | ❌ | ✅ | ✅ |
| Thread-level tools (`get_thread`, `list_inbox_threads`, `get_inbox_with_threads`) | ❌ | ✅ | ✅ |
| Download email to disk (`json`/`eml`/`txt`/`html`) | ❌ | ✅ | ✅ |
| Download attachment | ✅ | ✅ | ✅ |
| Download all attachments of a message at once, optionally as one ZIP (original filenames kept) | ❌ | ❌ | ✅ |
| `read_email` shows the Cc / Bcc lines (to decide between reply and reply-all) | ❌ | ✅ | ✅ |
| **OAuth / authorization** | | | |
| `--scopes` flag for least-privilege auth | ❌ | ✅ | ✅ |
| Tool list filtered by granted scopes | ❌ | ✅ | ✅ |
| OAuth credentials file mode `0o600` | ❌ | ✅ | ✅ |
| OAuth loopback callback checked with `state` and PKCE (S256), so an intercepted authorization code cannot be redeemed | ❌ | ❌ | ✅ |
| A `gcp-oauth.keys.json` left in the project folder is imported only by `auth`, never on a normal start | ❌ copied on every start | ❌ copied on every start | ✅ |
| **Security — input handling** | | | |
| CRLF header injection sanitization (`\r\n\0`) | ❌ | ⚠️ partial | ✅ |
| Path traversal in `download_attachment` | ❌ | ✅ fixed | ✅ |
| Path **jails** (attachment source + download destination) blocking prompt-injected exfiltration | ❌ | ❌ | ✅ |
| Symlink-safe writes (`O_NOFOLLOW` + post-`mkdir` realpath re-verification, TOCTOU defense) | ❌ | ❌ | ✅ |
| Zod bounds on `maxResults` / `batchSize` / `messageIds` length | ❌ | ❌ | ✅ |
| Cryptographic MIME boundary (`crypto.randomBytes`, not `Math.random`) | ❌ | ❌ | ✅ |
| **Security — outbound mail and prompt injection** | | | |
| Optional recipient allowlist (`GMAIL_MCP_RECIPIENT_PAIRING`): sends, replies, forwards and drafts go only to paired addresses | ❌ | ❌ | ✅ |
| With the allowlist on, the model cannot extend it through gmail-mcp: the human confirms in the MCP client, or runs `npx @klodr/gmail-mcp pair add` | ❌ | ❌ | ✅ |
| `send_draft` refuses a draft whose To / Cc / Bcc does not parse as addresses | — (no `send_draft`) | ❌ | ✅ |
| Write caps per tool family over 24 h and 30 days; batch tools count every message, not every call | ❌ | ❌ | ✅ |
| Filters that forward mail are refused (a forwarding rule silently redirects all future matching mail) | ❌ `create_filter` accepts `action.forward` | ❌ `create_filter` accepts `action.forward` | ✅ refused, with the reason |
| Downloaded files marked as coming from the internet (macOS quarantine, Windows Mark of the Web), as Mail and Outlook do | ❌ | ❌ | ✅ |
| Exported HTML: scripts, frames and forms blocked; remote images, stylesheets, fonts and media (tracking pixels) blocked unless asked for | — (no HTML export) | ❌ no CSP | ✅ |
| **MCP protocol & tool surface** | | | |
| MCP SDK version | v0.4.x | v1.27.x | v1.32.x |
| Tool annotations (`readOnlyHint` / `destructiveHint` / `idempotentHint`) | ❌ | ✅ | ✅ |
| `llms-install.md` (LLM-readable install guide) | ❌ | ❌ | ✅ |
| **Publishing / discoverability** | | | |
| Published on npm | ❌ stale — no future releases (repo archived) | ❌ (consumed as a GitHub install from the intermediate fork) | ✅ dedicated scoped package, signed releases |
| Active maintenance (last 30 d) | ❌ (archived 2026-03-03) | ⚠️ sporadic | ✅ daily review cycle (CodeRabbit + human) |
| **Supply-chain integrity** | | | |
| Node.js floor | ❌ `>=14` ([EOL April 2023](https://nodejs.org/en/about/previous-releases)) | ❌ `>=14` ([EOL April 2023](https://nodejs.org/en/about/previous-releases)) | ✅ `>=22` (Maintenance LTS until 2027-04-30) |
| CI: CodeQL Advanced (`javascript-typescript` + `actions`) | ❌ | ❌ | ✅ |
| CI: OpenSSF Scorecard (weekly scan + badge) | ❌ | ❌ | ✅ |
| CI: Socket Security supply-chain alerts | ❌ | ❌ | ✅ |
| CI: CodeRabbit assertive reviews on every PR | ❌ | ❌ | ✅ |
| Release: signed builds (Sigstore + SLSA in-toto attestation + npm provenance) | ❌ | ❌ | ✅ |
| Release: single-file ESM bundle | ❌ | ❌ | ✅ |
| **Testing** | | | |
| Unit/property tests | ❌ (0 tests) | ⚠️ (97 tests) | ✅ (**945 tests**, 43 files) |
| Statement coverage across `src/**` | 0% | 16.14% | **99.37%** (91% branch) |
| Fast-check property-based fuzz suite | ❌ | ❌ | ✅ |
| Hardening-specific test file (jails, CRLF, O_EXCL) | ❌ | ❌ | ✅ |
| **CI/CD hardening** | | | |
| Shell-injection-safe GitHub Actions workflows | ❌ | ✅ | ✅ |
| Workflows use least-privilege `permissions:` scopes | ❌ | ✅ | ✅ |
| All GitHub Actions pinned by full commit SHA | ❌ | ❌ | ✅ |
| **Operational** | | | |
| `CHANGELOG.md` (Keep-a-Changelog) | ❌ | ❌ | ✅ |
| `SECURITY.md` (vulnerability reporting) | ❌ | ❌ | ✅ |

`klodr/gmail-mcp` is the only one of the three with **(a)** source-path jails that make prompt-injection attachment exfiltration inert, **(b)** outbound guard rails a hostile email cannot talk the model past — an optional recipient allowlist the model cannot extend through gmail-mcp, no forwarding filters, write caps that count every message — **(c)** a modern supply chain (Scorecard, Socket, Sigstore), and **(d)** an in-repo review policy (`.coderabbit.yaml`) that every PR must pass before merge.

Fork columns checked against the code of [GongRzhe `a890d19`](https://github.com/GongRzhe/Gmail-MCP-Server/commit/a890d19) (2025-08-06, archived) and [ArtyMcLabin `83e8daf`](https://github.com/ArtyMcLabin/Gmail-MCP-Server/commit/83e8daf) (`main`, 2026-08-12).

## 📦 Installation

```bash
npm install -g @klodr/gmail-mcp
```

Or directly via `npx`:

```bash
npx -y @klodr/gmail-mcp
```

Requires **Node.js 22+**.

## ⚙️ Configuration

### 1️⃣ Google Cloud OAuth credentials

1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project and enable the **Gmail API**.
3. Under **APIs & Services → Credentials**, create an **OAuth 2.0 Client ID** (Desktop or Web). For Web, add `http://localhost:3000/oauth2callback` to the authorized redirect URIs.
4. Download the JSON, rename it to `gcp-oauth.keys.json`, place it at `~/.gmail-mcp/gcp-oauth.keys.json` (or override with `GMAIL_OAUTH_PATH=/abs/path/gcp-oauth.keys.json`).

### 2️⃣ Authenticate (once)

```bash
npx -y @klodr/gmail-mcp auth --scopes=gmail.readonly
```

Always pass `--scopes` with the minimum you actually need — the MCP filters the tool list at startup based on the granted scopes, so a read-only token doesn't expose write tools to the LLM. A browser opens for Google's consent flow; tokens are written to `~/.gmail-mcp/credentials.json` (mode `0o600`).

### 3️⃣ Register the server with your MCP client

```json
{
  "mcpServers": {
    "gmail": {
      "command": "npx",
      "args": ["-y", "@klodr/gmail-mcp"]
    }
  }
}
```

Client-specific config file:

- **Claude Code**: `~/.claude.json`
- **Claude Desktop**: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) / `%APPDATA%\Claude\claude_desktop_config.json` (Windows)
- **Cursor**: `~/.cursor/mcp.json`
- **OpenClaw**: `~/.openclaw/openclaw.json`

See [llms-install.md](./llms-install.md) for an LLM-readable install guide.

## 🔑 OAuth scopes

| Scope shorthand | Full Gmail scope | What it grants |
|---|---|---|
| `gmail.readonly` | `…/auth/gmail.readonly` | Read messages, threads, labels (filter tools require `gmail.settings.basic`) |
| `gmail.modify` | `…/auth/gmail.modify` | Readonly + apply/remove labels, delete messages |
| `gmail.compose` | `…/auth/gmail.compose` | Create drafts |
| `gmail.send` | `…/auth/gmail.send` | Send messages |
| `gmail.labels` | `…/auth/gmail.labels` | Manage labels only |
| `gmail.settings.basic` | `…/auth/gmail.settings.basic` | Manage filters |

Recipes:

```bash
# Read-only browsing
npx @klodr/gmail-mcp auth --scopes=gmail.readonly

# Read + send (mailing-list bot)
npx @klodr/gmail-mcp auth --scopes=gmail.readonly,gmail.send

# Everything (default; explicit)
npx @klodr/gmail-mcp auth --scopes=gmail.modify,gmail.settings.basic

# Default + permanent delete (delete_email / batch_delete_emails)
# gmail.modify authorizes trash; mail.google.com is the only scope
# that authorizes purging from Trash. Both are listed because the
# tool gate does exact scope-name matching — a token holding only
# mail.google.com would not enable the gmail.modify-gated tools,
# even though Google's scope hierarchy would technically accept the
# same calls.
npx @klodr/gmail-mcp auth --scopes=gmail.modify,mail.google.com,gmail.settings.basic
```

## 🛡️ Safeguards

### In-process middleware (autonomy enforcement)

The runtime constraints that an autonomous LLM client cannot violate are enforced *in the server*, not in the operator's attention span. Seven in-process modules sit on the tool entry path; the ones that are opt-in only activate when the matching env var is set.

**Always-on** (active for every call out of the box):

- **`sanitize.ts`** — strips/escapes input the LLM provides (CRLF injection, control characters, NUL bytes) before it reaches Gmail headers, filenames, or filesystem paths.
- **`sender-resolver.ts`** — resolves the `from` parameter against the account's authorized send-as aliases only. Spoofing the sender field is rejected before the Gmail API send call.
- **`rate-limit.ts`** — bounds write volume per tool family (`send`, `delete`, `modify`, `drafts`, `labels`, `filters`, `pairing`) over rolling daily/monthly windows. The batch tools (`batch_modify_emails`, `batch_delete_emails`, `move_to_spam_batch`) count each message they touch, so one call on 1 000 messages uses 1 000 units, not 1. The state is persisted to disk so it survives restarts. Disable with `GMAIL_MCP_RATE_LIMIT_DISABLE=true` for test runs only.
- **`quarantine.ts`** — marks every file written by `download_attachment`, `download_all_attachments` and `download_email` as downloaded from the internet, as Mail and Outlook do: the `com.apple.quarantine` attribute on macOS (Gatekeeper checks an executable or script when it is opened), the Mark of the Web on Windows; nothing on Linux. Never blocking: if the mark cannot be set, the file is still saved. Off with `GMAIL_MCP_QUARANTINE=false`.
- **Forwarding filters refused** (`filter-manager.ts`) — `create_filter` and the filter templates never install a rule that forwards mail: such a rule silently redirects every future matching message, and Gmail forwards only to a verified forwarding address, whose registration needs the `gmail.settings.sharing` scope — not in the default scopes and used by no tool here; the refusal holds even if `--scopes` grants it. Create those in the Gmail web interface.
- **Exported HTML** (`email-export.ts`) — the file `download_email` writes in `html` format carries a Content-Security-Policy blocking scripts, plugins, frames, `<base>` rewrites and form submissions, and by default every remote fetch — images, stylesheets, fonts, media and the rest (`default-src 'none'`) — so a tracking pixel or stylesheet cannot report when and where the copy is opened (inline styles and images still render); a sender's `<meta http-equiv="refresh">` is neutralized. Allow remote content per call with `allowRemoteImages: true` or globally with `GMAIL_MCP_EXPORT_REMOTE_IMAGES=true`.
- **`send_draft` recipient check** — the staged draft is read before sending, and a To / Cc / Bcc header that does not parse as a list of addresses is refused, so a draft's destination is always known.
- **`gmail-errors.ts`** — normalizes Gmail API failure modes into typed errors so retries and surfacing to the LLM are deterministic.
- **`middleware.ts`** — composes the always-on chain and binds it to every tool entry point. New tools inherit the pipeline by construction.

**Opt-in** (off by default, set the env var to engage):

- **`recipient-pairing.ts`** — refuses to send mail to addresses that are not on the operator-controlled allow-list (`~/.gmail-mcp/paired.json`). No fresh outbound destinations from a hallucinated address. Engages when `GMAIL_MCP_RECIPIENT_PAIRING=true`; gates the `send_email` / `reply_*` / `forward_email` / `draft_email` / `update_draft` / `send_draft` family. Addresses are compared bare (`Name <address>` matches the paired `address`). While the gate is on, the model cannot extend the list through gmail-mcp: `pair_recipient add` asks the human to confirm through the MCP client (elicitation) and, where the client cannot ask, refuses and names the terminal command — `npx @klodr/gmail-mcp pair add <address>` (also `pair remove`, `pair list`). Otherwise a hostile email could tell the agent to pair its own address, then write to it. The guarantee covers the gmail-mcp surface: it holds as long as the MCP client does not also let the model run terminal commands (such as `npx @klodr/gmail-mcp pair add`) or write `paired.json` without your approval.
- **`audit-log.ts`** — append-only JSONL trail of every tool call (name, redacted args, outcome) with structural-key-preserving redaction so operators can replay decisions post-hoc. Engages when `GMAIL_MCP_AUDIT_LOG=/abs/path/audit.jsonl` is set.

Configure each module via the env vars below:

| Knob | Env var | Default | Notes |
|---|---|---|---|
| Attachment jail | `GMAIL_MCP_ATTACHMENT_DIR=/abs/path` | `~/GmailAttachments/` (auto-created mode `0o700`) | Every attachment path (`send_email`, `draft_email`, `update_draft`, `reply_all`, `reply_to_email`, `forward_email`) must live inside this directory after `realpath` canonicalization. Symlinks pointing outside are rejected. Blocks prompt-injected exfiltration of `~/.ssh/id_rsa`, `~/.gmail-mcp/credentials.json`, `~/.claude.json`, etc. |
| Download jail | `GMAIL_MCP_DOWNLOAD_DIR=/abs/path` | `~/GmailDownloads/` (auto-created mode `0o700`) | `download_email`, `download_attachment` and `download_all_attachments` (each file and the ZIP) write exclusively here. The leaf is opened with `O_NOFOLLOW`; post-`mkdir` the resolved path is re-verified against the jail root (TOCTOU defense). |
| OAuth keys path | `GMAIL_OAUTH_PATH=/abs/path/gcp-oauth.keys.json` | `~/.gmail-mcp/gcp-oauth.keys.json` | Google Desktop/Web OAuth client credentials. |
| Credentials path | `GMAIL_CREDENTIALS_PATH=/abs/path/credentials.json` | `~/.gmail-mcp/credentials.json` | Access/refresh tokens. File mode `0o600`. |
| Rate limit state dir | `GMAIL_MCP_STATE_DIR=/abs/path` | `~/.gmail-mcp/` | Where the rolling call-history for rate limiting is persisted (`ratelimit.json`, mode `0o600`). Same directory is reused for any future state files. |
| Rate limit overrides | `GMAIL_MCP_RATE_LIMIT_<bucket>=D/day,M/month` | see below | Override the per-bucket daily/monthly caps. Buckets: `send` (100/2000), `delete` (1000/10000), `modify` (5000/50000), `drafts` (300/3000), `labels` (50/500), `filters` (20/200), `pairing` (50/500). `delete` and `modify` are counted in messages for the batch tools: 5 000 modifications a day cover five full 1 000-message batches (a large inbox clean-up) and still stop a runaway loop; permanent deletion stays at 1 000 a day. Every outbound tool (`send_email`, `reply_all`, `reply_to_email`, `forward_email`, `send_draft`) shares the `send` bucket. The `send` cap is sized at the upper end of a human professional workload (~40 emails/day with a 2.5× cushion); raise it via `GMAIL_MCP_RATE_LIMIT_send=400/day,6000/month` if you need the pre-v0.30.2 default. The bucket name is lowercase and matches the tool family. |
| Rate limit disable | `GMAIL_MCP_RATE_LIMIT_DISABLE=true` | unset (limiter active) | Kill-switch for the entire limiter. Use only for test suites or controlled batch operations. |
| Recipient pairing | `GMAIL_MCP_RECIPIENT_PAIRING=true` | unset (no allowlist) | Sends only to paired addresses (`GMAIL_MCP_PAIRED_PATH`, default `~/.gmail-mcp/paired.json`). Pair from a terminal with `npx @klodr/gmail-mcp pair add <address>`, or through `pair_recipient`, which asks you to confirm. |
| Pairing confirmation wait | `GMAIL_MCP_PAIRING_CONFIRM_TIMEOUT_MS=600000` | 10 minutes | How long `pair_recipient add` waits for you to answer the confirmation form before giving up (nothing is paired). Positive integer in milliseconds; any other value falls back to the default. Your MCP client's own tool-call timeout can end the wait sooner. |
| Quarantine of downloads | `GMAIL_MCP_QUARANTINE=false` | on | macOS `com.apple.quarantine` / Windows Mark of the Web on every downloaded file; nothing on Linux. Never blocks a download. |
| Remote content (images, stylesheets, fonts, media) in exported HTML | `GMAIL_MCP_EXPORT_REMOTE_IMAGES=true` | blocked | Default for `download_email` in `html` format; a per-call `allowRemoteImages` wins. |
| Audit log | `GMAIL_MCP_AUDIT_LOG=/abs/path/audit.jsonl` | unset (no audit trail) | Opt-in append-only JSONL log of every tool call (name, redacted args, outcome). File mode `0o600`. Must be an absolute path; relative paths are rejected at startup. Redaction keeps structural keys and drops values under an allowlist. |
| Dry-run | `GMAIL_MCP_DRY_RUN=true` | unset (real calls) | When `"true"` (strict match), every write tool (`send_email`, `reply_all`, `reply_to_email`, `forward_email`, `draft_email`, `update_draft`, `delete_draft`, `send_draft`, `delete_email`, `modify_email`, `batch_modify_emails`, `move_to_spam`, `move_to_spam_batch`, `batch_delete_emails`, `create_label`, `update_label`, `delete_label`, `get_or_create_label`, `create_filter`, `delete_filter`, `create_filter_from_template`, `modify_thread`, `pair_recipient`) short-circuits before reaching Gmail and returns the redacted payload it would have sent. This is exactly the set of rate-limited tools. `pair_recipient` is short-circuited for every action, `list` included. Useful for CI smoke tests, agent debugging, and human-in-the-loop approval flows. Read tools and the local-only `download_*` tools ignore the flag (nothing to preview in the mailbox). Matches `MERCURY_MCP_DRY_RUN` / `FAXDROP_MCP_DRY_RUN` on the sibling servers. |

## 🛠️ Tools

The exact set depends on the OAuth scopes granted at `auth` time. Full catalog:

- **Messages** — `send_email`, `draft_email`, `read_email`, `search_emails`, `modify_email`, `delete_email`, `download_email`, `download_attachment`, `download_all_attachments`, `batch_modify_emails`, `batch_delete_emails`, `reply_all`, `reply_to_email`, `forward_email`
- **Drafts** — `list_drafts`, `get_draft`, `update_draft`, `delete_draft`, `send_draft` (full `users.drafts.*` surface; `draft_email` above creates the initial draft)
- **Threads** — `get_thread`, `list_inbox_threads`, `get_inbox_with_threads`, `modify_thread`
- **Labels** — `list_email_labels`, `create_label`, `update_label`, `delete_label`, `get_or_create_label`
- **Filters** — `list_filters`, `get_filter`, `create_filter`, `delete_filter`, `create_filter_from_template`
- **Recipient pairing** — `pair_recipient` (manage the `~/.gmail-mcp/paired.json` allowlist when `GMAIL_MCP_RECIPIENT_PAIRING=true`)

Every write tool is annotated with `destructiveHint` / `readOnlyHint` / `idempotentHint` per the MCP spec so policy-aware clients can gate on HITL confirmation.

### 🔍 `search_emails` query syntax

`search_emails` accepts Gmail's native search operators — `from:`, `to:`, `subject:`, `has:attachment`, `after:YYYY/MM/DD`, `before:YYYY/MM/DD`, `is:unread`, `label:<name>`, etc. They combine freely: `from:alice@example.com after:2026/01/01 has:attachment`. Full reference: [Google's Gmail search operators cheat sheet](https://support.google.com/mail/answer/7190).

## 🗺️ Roadmap

See [ROADMAP.md](docs/ROADMAP.md).

## 🌐 Ecosystem

### Other MCP servers in the klodr family

- 📧 [klodr/gmail-mcp](https://github.com/klodr/gmail-mcp) — Gmail (you are here)
- 📠 [klodr/faxdrop-mcp](https://github.com/klodr/faxdrop-mcp) — Send real faxes via FaxDrop
- 🏦 [klodr/mercury-invoicing-mcp](https://github.com/klodr/mercury-invoicing-mcp) — Mercury banking + invoicing

### Wider Gmail-MCP landscape

29 standalone repositories and 349 forks of the original GongRzhe server are reviewed in [docs/COMPETITORS.md](./docs/COMPETITORS.md) — which ideas we borrowed, which we chose not to, and where `klodr/gmail-mcp` sits on the maturity axes.

## 🤝 Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for the test / build / lint checklist and release process.

## 🔒 Security

See [SECURITY.md](.github/SECURITY.md) for the vulnerability-reporting process and the current security model, and [ASSURANCE_CASE.md](docs/ASSURANCE_CASE.md) for the threat model, trust boundaries, and CWE/OWASP mitigation table.

## 📋 Project continuity

See [CONTINUITY.md](docs/CONTINUITY.md) for the handover plan if the maintainer becomes unavailable.

## 📄 License

MIT — see [LICENSE](./LICENSE).

## 📜 History

`klodr/gmail-mcp` is the maintenance fork of a two-step upstream chain:

- **[GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server)** — the original server. Unmaintained since August 2025 (7+ months with zero maintainer activity and 72+ unmerged pull requests).
- **[ArtyMcLabin/Gmail-MCP-Server](https://github.com/ArtyMcLabin/Gmail-MCP-Server)** — Arty MacKiewicz's active fork. Since divergence from Gong, it merged community contributions including: reply-all ([#3](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/3) by @MaxGhenis), `list_filters` fix ([#4](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/4) by @nicholas-anthony-ai), CI/CD shell-injection hardening ([#9](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/9) by @JF10R), `download_email` ([#13](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/13) by @icanhasjonas), tool annotations ([#14](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/14) by @bryankthompson), CC/BCC fields in `read_email` ([#21](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/21) by @panghy), and draft lifecycle tools `send_draft` / `delete_draft` / `update_draft` ([#30](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/30) by @thisisambros). Reply-threading auto-resolution and the `--scopes` flag were folded in directly by the maintainer.

`klodr/gmail-mcp` carries all of the above forward and adds the supply-chain / path-jail / review-policy layer (see comparison table above). Credit to every PR author along the chain.
