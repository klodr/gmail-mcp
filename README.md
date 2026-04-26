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
> Hardened + enhanced fork of [GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server) (archived 2026-03-03), via [ArtyMcLabin/Gmail-MCP-Server](https://github.com/ArtyMcLabin/Gmail-MCP-Server). Since the divergence point: **121 commits** (75 ahead of ArtyMcLabin) and **+26 700 / -10 400 lines** across security hardening, Gmail-surface improvements (reply-all, send-as alias, thread-level tools, download-to-disk, recipient pairing, batch ops with retry…), supply-chain hygiene, and CI gating. Every PR goes through CodeRabbit + dual-model Qodo Merge before merge. See [SECURITY.md](.github/SECURITY.md) for the controls and threat model, and the [comparison table](#-why-this-mcp) below for the parent-forks delta.

A Model Context Protocol (MCP) server that lets AI assistants (Claude Desktop, Claude Code, Cursor, Continue, OpenClaw…) read and manage a Gmail account through scope-gated tools. Exposes the Gmail v1 API surface you actually need (messages, threads, labels, filters, attachments, drafts, reply-all) behind a single `npx` install.

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
| **OAuth / authorization** | | | |
| `--scopes` flag for least-privilege auth | ❌ | ✅ | ✅ |
| Tool list filtered by granted scopes | ❌ | ✅ | ✅ |
| OAuth credentials file mode `0o600` | ❌ | ✅ | ✅ |
| **Security — input handling** | | | |
| CRLF header injection sanitization (`\r\n\0`) | ❌ | ⚠️ partial | ✅ |
| Path traversal in `download_attachment` | ❌ | ✅ fixed | ✅ |
| Attachment source **jail** (`GMAIL_MCP_ATTACHMENT_DIR`) blocks exfiltration of `~/.ssh/id_rsa` etc. via prompt injection | ❌ | ❌ | ✅ |
| Download destination **jail** (`GMAIL_MCP_DOWNLOAD_DIR`) | ❌ | ❌ | ✅ |
| `O_NOFOLLOW` on leaf writes (pre-existing symlink at destination rejected) | ❌ | ❌ | ✅ |
| Post-`mkdir` realpath re-verification (TOCTOU defense) | ❌ | ❌ | ✅ |
| Zod bounds on `maxResults` / `batchSize` / `messageIds` length | ❌ | ❌ | ✅ |
| Cryptographic MIME boundary (`crypto.randomBytes`, not `Math.random`) | ❌ | ❌ | ✅ |
| **MCP protocol & tool surface** | | | |
| MCP SDK version | v0.4.x | v1.27.x | v1.29.x |
| Tool annotations (`readOnlyHint` / `destructiveHint` / `idempotentHint`) | ❌ | ✅ | ✅ |
| `llms-install.md` (LLM-readable install guide) | ❌ | ❌ | ✅ |
| **Publishing / discoverability** | | | |
| Published on npm | ❌ stale — no future releases (repo archived) | ❌ (consumed as a GitHub install from the intermediate fork) | ✅ dedicated scoped package, signed releases |
| Active maintenance (last 30 d) | ❌ (archived 2026-03-03) | ⚠️ sporadic | ✅ daily review cycle (CodeRabbit + human) |
| **Supply-chain integrity** | | | |
| Node.js floor | ❌ `>=14` ([EOL April 2023](https://nodejs.org/en/about/previous-releases)) | ❌ `>=14` ([EOL April 2023](https://nodejs.org/en/about/previous-releases)) | ✅ `>=22` (Active LTS, maintenance until 2027-04-30) |
| CI: CodeQL Advanced (`javascript-typescript` + `actions`) | ❌ | ❌ | ✅ |
| CI: OpenSSF Scorecard (weekly scan + badge) | ❌ | ❌ | ✅ |
| CI: Socket Security supply-chain alerts | ❌ | ❌ | ✅ |
| CI: CodeRabbit assertive reviews on every PR | ❌ | ❌ | ✅ |
| Release: Sigstore-signed `dist/index.js` + SLSA in-toto attestation | ❌ | ❌ | ✅ |
| Release: npm provenance statement | ❌ | ❌ | ✅ |
| Release: single-file ESM bundle | ❌ | ❌ | ✅ |
| **Testing** | | | |
| Unit/property tests | ❌ (0 tests) | ⚠️ (97 tests) | ✅ (560 tests) |
| Statement coverage across `src/**` | 0% | 16.14% | **>93%** |
| Fast-check property-based fuzz suite | ❌ | ❌ | ✅ |
| Hardening-specific test file (jails, CRLF, O_EXCL) | ❌ | ❌ | ✅ |
| **CI/CD hardening** | | | |
| Shell-injection-safe GitHub Actions workflows | ❌ | ✅ | ✅ |
| Workflows use least-privilege `permissions:` scopes | ❌ | ✅ | ✅ |
| All GitHub Actions pinned by full commit SHA | ❌ | ❌ | ✅ |
| **Operational** | | | |
| `CHANGELOG.md` (Keep-a-Changelog) | ❌ | ❌ | ✅ |
| `SECURITY.md` (vulnerability reporting) | ❌ | ❌ | ✅ |

`klodr/gmail-mcp` is the only one of the three with **(a)** source-path jails that make prompt-injection attachment exfiltration inert, **(b)** a modern supply chain (Scorecard, Socket, Sigstore), and **(c)** an in-repo review policy (`.coderabbit.yaml`) that every PR must pass before merge.

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
3. Under **APIs & Services → Credentials**, create an **OAuth 2.0 Client ID** (Desktop or Web). For Web, add `http://localhost:3000/oauth2callback` to the authorised redirect URIs.
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

| Knob | Env var | Default | Notes |
|---|---|---|---|
| Attachment jail | `GMAIL_MCP_ATTACHMENT_DIR=/abs/path` | `~/GmailAttachments/` (auto-created mode `0o700`) | Every attachment path (`send_email`, `draft_email`, `reply_all`, `reply_to_email`, `forward_email`) must live inside this directory after `realpath` canonicalization. Symlinks pointing outside are rejected. Blocks prompt-injected exfiltration of `~/.ssh/id_rsa`, `~/.gmail-mcp/credentials.json`, `~/.claude.json`, etc. |
| Download jail | `GMAIL_MCP_DOWNLOAD_DIR=/abs/path` | `~/GmailDownloads/` (auto-created mode `0o700`) | `download_email` and `download_attachment` write exclusively here. The leaf is opened with `O_NOFOLLOW`; post-`mkdir` the resolved path is re-verified against the jail root (TOCTOU defense). |
| OAuth keys path | `GMAIL_OAUTH_PATH=/abs/path/gcp-oauth.keys.json` | `~/.gmail-mcp/gcp-oauth.keys.json` | Google Desktop/Web OAuth client credentials. |
| Credentials path | `GMAIL_CREDENTIALS_PATH=/abs/path/credentials.json` | `~/.gmail-mcp/credentials.json` | Access/refresh tokens. File mode `0o600`. |
| Rate limit state dir | `GMAIL_MCP_STATE_DIR=/abs/path` | `~/.gmail-mcp/` | Where the rolling call-history for rate limiting is persisted (`ratelimit.json`, mode `0o600`). Same directory is reused for any future state files. |
| Rate limit overrides | `GMAIL_MCP_RATE_LIMIT_<bucket>=D/day,M/month` | see below | Override the per-bucket daily/monthly caps. Buckets: `send` (400/6000), `delete` (200/2000), `modify` (500/5000), `drafts` (300/3000), `labels` (50/500), `filters` (20/200). The bucket name is lowercase and matches the tool family. Example: `GMAIL_MCP_RATE_LIMIT_send=100/day,1500/month`. |
| Rate limit disable | `GMAIL_MCP_RATE_LIMIT_DISABLE=true` | unset (limiter active) | Kill-switch for the entire limiter. Use only for test suites or controlled batch operations. |
| Audit log | `GMAIL_MCP_AUDIT_LOG=/abs/path/audit.jsonl` | unset (no audit trail) | Opt-in append-only JSONL log of every tool call (name, redacted args, outcome). File mode `0o600`. Must be an absolute path; relative paths are rejected at startup. Redaction keeps structural keys and drops values under an allowlist. |
| Dry-run | `GMAIL_MCP_DRY_RUN=true` | unset (real calls) | When `"true"` (strict match), every write tool (`send_email`, `reply_all`, `reply_to_email`, `forward_email`, `draft_email`, `delete_email`, `modify_email`, `batch_modify_emails`, `batch_delete_emails`, `create_label`, `update_label`, `delete_label`, `get_or_create_label`, `create_filter`, `delete_filter`, `create_filter_from_template`, `modify_thread`) short-circuits before reaching Gmail and returns the redacted payload it would have sent. Useful for CI smoke tests, agent debugging, and human-in-the-loop approval flows. Read tools ignore the flag (nothing to preview). Matches `MERCURY_MCP_DRY_RUN` / `FAXDROP_MCP_DRY_RUN` on the sibling servers. |

## 🛠️ Tools

The exact set depends on the OAuth scopes granted at `auth` time. Full catalog:

- **Messages** — `send_email`, `draft_email`, `read_email`, `search_emails`, `modify_email`, `delete_email`, `download_email`, `download_attachment`, `batch_modify_emails`, `batch_delete_emails`, `reply_all`, `reply_to_email`, `forward_email`
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

29 standalone repositories and 323 forks of the original GongRzhe server are reviewed in [docs/COMPETITORS.md](./docs/COMPETITORS.md) — which ideas we borrowed, which we chose not to, and where `klodr/gmail-mcp` sits on the maturity axes.

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
- **[ArtyMcLabin/Gmail-MCP-Server](https://github.com/ArtyMcLabin/Gmail-MCP-Server)** — Arty MacKiewicz's active fork, which merged a pile of long-pending community PRs: reply threading ([#91](https://github.com/GongRzhe/Gmail-MCP-Server/pull/91)), reply-all ([#3](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/3) by @MaxGhenis), `list_filters` fix ([#4](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/4) by @nicholas-anthony-ai), `--scopes` flag ([#6](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/6) by @tansanDOTeth), CI/CD hardening ([#9](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/9)) + security hardening ([#10](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/10)) + dependency CVE fixes ([#11](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/11)) by @JF10R, tool annotations ([#14](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/14) by @bryankthompson), `download_email` ([#13](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/13) by @icanhasjonas).

`klodr/gmail-mcp` carries all of the above forward and adds the supply-chain / path-jail / review-policy layer (see comparison table above). Credit to every PR author along the chain.
