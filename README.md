# gmail-mcp

> Read, search, send, draft, label, filter, and thread Gmail from any MCP-enabled AI assistant. Wraps the [Gmail API](https://developers.google.com/gmail/api) with scope-gated tools and in-process safeguards.

[![CI](https://github.com/klodr/gmail-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/klodr/gmail-mcp/actions/workflows/ci.yml)
[![CodeQL](https://github.com/klodr/gmail-mcp/actions/workflows/codeql.yml/badge.svg)](https://github.com/klodr/gmail-mcp/actions/workflows/codeql.yml)
[![Tested with Vitest](https://img.shields.io/badge/tested%20with-vitest-yellow?logo=vitest&labelColor=black)](https://vitest.dev)
[![codecov](https://codecov.io/gh/klodr/gmail-mcp/branch/main/graph/badge.svg)](https://codecov.io/gh/klodr/gmail-mcp)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/klodr/gmail-mcp/badge)](https://scorecard.dev/viewer/?uri=github.com/klodr/gmail-mcp)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/12613/badge)](https://www.bestpractices.dev/projects/12613)
[![Socket Security](https://socket.dev/api/badge/npm/package/@klodr/gmail-mcp)](https://socket.dev/npm/package/@klodr/gmail-mcp)
[![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/klodr/gmail-mcp?utm_source=oss&utm_medium=github&utm_campaign=klodr%2Fgmail-mcp&labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews)](https://coderabbit.ai)

[![npm version](https://img.shields.io/npm/v/@klodr/gmail-mcp.svg)](https://www.npmjs.com/package/@klodr/gmail-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@klodr/gmail-mcp.svg)](https://www.npmjs.com/package/@klodr/gmail-mcp)
[![Node.js Version](https://img.shields.io/node/v/@klodr/gmail-mcp.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCP](https://img.shields.io/badge/MCP-1.27-blue)](https://modelcontextprotocol.io)
[![MCP Server](https://badge.mcpx.dev?type=server 'MCP Server')](https://modelcontextprotocol.io)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/klodr/gmail-mcp/pulls)

[![Sponsor on GitHub](https://img.shields.io/github/sponsors/klodr?logo=github-sponsors&label=GitHub%20Sponsors&color=EA4AAA)](https://github.com/sponsors/klodr)
[![Patreon](https://img.shields.io/badge/Patreon-F96854?logo=patreon&logoColor=white)](https://www.patreon.com/klodr)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-FF5E5B?logo=kofi&logoColor=white)](https://ko-fi.com/klodr)

> [!WARNING]
> **This repository has not yet been independently security-reviewed end-to-end and is not recommended for production use in its current state.** A security audit is in progress (see `feat/security-hardening` branch and open PRs). Use at your own risk until the audit lands.

A Model Context Protocol (MCP) server that lets AI assistants (Claude Desktop, Claude Code, Cursor, Continue, OpenClaw…) read and manage a Gmail account through scope-gated tools. Exposes the Gmail v1 API surface you actually need (messages, threads, labels, filters, attachments, drafts, reply-all) behind a single `npx` install.

## Why this MCP?

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
| MCP SDK version | v1.0 (3 CVEs) | v1.27.1 | v1.27.1 |
| Tool annotations (`readOnlyHint` / `destructiveHint` / `idempotentHint`) | ❌ | ✅ | ✅ |
| `llms-install.md` (LLM-readable install guide) | ❌ | ❌ | ✅ |
| **Publishing / discoverability** | | | |
| Published on npm | ✅ [@gongrzhe/server-gmail-autoauth-mcp](https://www.npmjs.com/package/@gongrzhe/server-gmail-autoauth-mcp) (stale — no release since the fork diverged) | ❌ (consumed as a GitHub install from the intermediate fork) | ✅ [@klodr/gmail-mcp](https://www.npmjs.com/package/@klodr/gmail-mcp) (dedicated scoped package, signed releases) |
| GitHub repo | [GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server) | [ArtyMcLabin/Gmail-MCP-Server](https://github.com/ArtyMcLabin/Gmail-MCP-Server) | [klodr/gmail-mcp](https://github.com/klodr/gmail-mcp) |
| Active maintenance (last 30 d) | ❌ (dormant since Aug 2025) | ⚠️ sporadic | ✅ daily review cycle (CodeRabbit + human) |
| **Supply-chain integrity** | | | |
| Node.js floor | `>=14` (EOL) | `>=14` (EOL) | `>=20.11` |
| CI: CodeQL Advanced (`javascript-typescript` + `actions`) | ❌ | ❌ | ✅ |
| CI: OpenSSF Scorecard (weekly scan + badge) | ❌ | ❌ | ✅ |
| CI: Socket Security supply-chain alerts | ❌ | ❌ | ✅ |
| CI: CodeRabbit assertive reviews on every PR | ❌ | ❌ | ✅ |
| Release: Sigstore-signed `dist/index.js` + SLSA in-toto attestation | ❌ | ❌ | ✅ |
| Release: npm provenance statement | ❌ | ❌ | ✅ |
| Release: single-file `tsup` ESM bundle (smaller tarball, easier to verify) | ❌ (multi-file `tsc`) | ❌ (multi-file `tsc`) | ✅ |
| **CI/CD hardening** | | | |
| Shell-injection-safe GitHub Actions workflows | ❌ | ✅ | ✅ |
| Workflows use least-privilege `permissions:` scopes | ❌ | ✅ | ✅ |
| All GitHub Actions pinned by full commit SHA | ❌ | ❌ | ✅ |
| **Operational** | | | |
| `CHANGELOG.md` (Keep-a-Changelog) | ❌ | ❌ | ✅ |
| `SECURITY.md` (vulnerability reporting) | ❌ | ❌ | ✅ |
| `CONTRIBUTING.md` | ❌ | ❌ | ✅ |
| `.github/FUNDING.yml` | ❌ | ❌ | ✅ |

The klodr fork is the only one of the three with **(a)** source-path jails that make prompt-injection attachment exfiltration inert, **(b)** a modern supply chain (Scorecard, Socket, Sigstore), and **(c)** an in-repo review policy (`.coderabbit.yaml`) that every PR must pass before merge.

## Installation

```bash
npm install -g @klodr/gmail-mcp
```

Or directly via `npx`:

```bash
npx -y @klodr/gmail-mcp
```

Requires **Node.js 20.11+**.

## Configuration

### 1. Google Cloud OAuth credentials

1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project and enable the **Gmail API**.
3. Under **APIs & Services → Credentials**, create an **OAuth 2.0 Client ID** (Desktop or Web). For Web, add `http://localhost:3000/oauth2callback` to the authorised redirect URIs.
4. Download the JSON, rename it to `gcp-oauth.keys.json`, place it at `~/.gmail-mcp/gcp-oauth.keys.json` (or override with `GMAIL_OAUTH_PATH=/abs/path/gcp-oauth.keys.json`).

### 2. Authenticate (once)

```bash
npx -y @klodr/gmail-mcp auth --scopes=gmail.readonly
```

Always pass `--scopes` with the minimum you actually need — the MCP filters the tool list at startup based on the granted scopes, so a read-only token doesn't expose write tools to the LLM. A browser opens for Google's consent flow; tokens are written to `~/.gmail-mcp/credentials.json` (mode `0o600`).

### 3. Register the server with your MCP client

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

## OAuth scopes

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
```

## Safeguards

| Knob | Env var | Default | Notes |
|---|---|---|---|
| Attachment jail | `GMAIL_MCP_ATTACHMENT_DIR=/abs/path` | `~/GmailAttachments/` (auto-created mode `0o700`) | Every attachment path (`send_email`, `draft_email`, `reply_all`) must live inside this directory after `realpath` canonicalization. Symlinks pointing outside are rejected. Blocks prompt-injected exfiltration of `~/.ssh/id_rsa`, `~/.gmail-mcp/credentials.json`, `~/.claude.json`, etc. |
| Download jail | `GMAIL_MCP_DOWNLOAD_DIR=/abs/path` | `~/GmailDownloads/` (auto-created mode `0o700`) | `download_email` and `download_attachment` write exclusively here. The leaf is opened with `O_NOFOLLOW`; post-`mkdir` the resolved path is re-verified against the jail root (TOCTOU defense). |
| OAuth keys path | `GMAIL_OAUTH_PATH=/abs/path/gcp-oauth.keys.json` | `~/.gmail-mcp/gcp-oauth.keys.json` | Google Desktop/Web OAuth client credentials. |
| Credentials path | `GMAIL_CREDENTIALS_PATH=/abs/path/credentials.json` | `~/.gmail-mcp/credentials.json` | Access/refresh tokens. File mode `0o600`. |

## Tools

The exact set depends on the OAuth scopes granted at `auth` time. Full catalog:

- **Messages** — `send_email`, `draft_email`, `read_email`, `search_emails`, `modify_email`, `delete_email`, `download_email`, `download_attachment`, `batch_modify_emails`, `batch_delete_emails`, `reply_all`
- **Threads** — `get_thread`, `list_inbox_threads`, `get_inbox_with_threads`, `modify_thread`
- **Labels** — `list_email_labels`, `create_label`, `update_label`, `delete_label`, `get_or_create_label`
- **Filters** — `list_filters`, `get_filter`, `create_filter`, `delete_filter`, `create_filter_from_template`

Every write tool is annotated with `destructiveHint` / `readOnlyHint` / `idempotentHint` per the MCP spec so policy-aware clients can gate on HITL confirmation.

### `search_emails` query syntax

`search_emails` accepts Gmail's native search operators — `from:`, `to:`, `subject:`, `has:attachment`, `after:YYYY/MM/DD`, `before:YYYY/MM/DD`, `is:unread`, `label:<name>`, etc. They combine freely: `from:alice@example.com after:2026/01/01 has:attachment`. Full reference: [Google's Gmail search operators cheat sheet](https://support.google.com/mail/answer/7190).

## Roadmap

Loose planning horizon of ~12 months, ordered by intent (not a commitment):

### Near-term (next release cycle)

- **Complete code audit** — this fork inherits code from two upstream chains (GongRzhe → ArtyMcLabin) and still carries patterns, dead branches, and duplicated helpers from both. A single pass through every file in `src/`, with the security-hardening posture as the baseline, to remove what is not used, consolidate what is duplicated, and document what remains non-obvious. Not a rewrite — a cleanup. Blocks v1.0.0.
- **v1.0.0 on npm** — cut the first tagged release of `@klodr/gmail-mcp` once the audit lands on `main`; every release is signed with Sigstore (keyless GitHub OIDC), ships an SLSA in-toto attestation, and carries npm provenance.
- **Recipient pairing gate** — add a `pair_recipient` tool and a `~/.gmail-mcp/paired.json` allowlist so `send_email` / `reply_all` / `draft_email` refuse to email an address the human has never approved, capping the blast radius of a prompt-injected `send_email` call.
- **Optional audit log** — `GMAIL_MCP_AUDIT_LOG=/abs/path` for a redacted JSONL trail (mode `0o600`) of every tool call, with sensitive fields (OAuth tokens, message bodies, attachment bytes) stripped before write.

### Gmail API surface not yet wrapped

The MCP currently covers ~25 tools across messages, threads, labels, and filters. Planned additions as demand emerges:

- **Drafts CRUD** — `drafts.list`, `drafts.get`, `drafts.update`, `drafts.delete`, `drafts.send` (only `drafts.create` is wired today via `draft_email`).
- **Send-as aliases** — `settings.sendAs.*` (create / update / delete / verify) for managing Gmail aliases programmatically.
- **Vacation responder** — `settings.vacation` get/update for enabling/disabling the auto-responder.
- **Forwarding addresses** — `settings.forwardingAddresses.*`.
- **POP / IMAP settings** — `settings.pop`, `settings.imap`.
- **Push notifications** — `users.watch` + `users.history.list` for near-real-time inbox event streaming.

### Discoverability

- **MCP registries** — publish the server to the public MCP indexes once v1.0.0 is cut, so agent platforms can discover it without a manual config line. Targets: the [official MCP Registry](https://github.com/modelcontextprotocol/registry), [mcp.so](https://mcp.so), [glama.ai](https://glama.ai/mcp), [smithery.ai](https://smithery.ai).

### Compliance / governance

- **OpenSSF Best Practices Silver** — close the remaining gaps (code of conduct, DCO enforcement, this roadmap) and push the badge to Silver.
- **Second maintainer** — actively welcome co-maintainership via `.github/CODEOWNERS` once a contributor has several merged PRs; Gold-level requirements (≥2 active maintainers) are the longer-term motivator.
- **MCP SDK majors** — follow the `@modelcontextprotocol/sdk` major-version train; migrate to Zod v4-only idioms once the SDK floor allows.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the test / build / lint checklist and release process.

## Security

See [SECURITY.md](./SECURITY.md) for the vulnerability-reporting process and the current security model, and [ASSURANCE_CASE.md](./ASSURANCE_CASE.md) for the threat model, trust boundaries, and CWE/OWASP mitigation table.

## Project continuity

See [CONTINUITY.md](./CONTINUITY.md) for the handover plan if the maintainer becomes unavailable.

## License

MIT — see [LICENSE](./LICENSE).

## History

This repository is the klodr maintenance fork of a two-step upstream chain:

- **[GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server)** — the original server. Unmaintained since August 2025 (7+ months with zero maintainer activity and 72+ unmerged pull requests).
- **[ArtyMcLabin/Gmail-MCP-Server](https://github.com/ArtyMcLabin/Gmail-MCP-Server)** — Arty MacKiewicz's active fork, which merged a pile of long-pending community PRs: reply threading ([#91](https://github.com/GongRzhe/Gmail-MCP-Server/pull/91)), reply-all ([#3](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/3) by @MaxGhenis), `list_filters` fix ([#4](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/4) by @nicholas-anthony-ai), `--scopes` flag ([#6](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/6) by @tansanDOTeth), CI/CD hardening ([#9](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/9)) + security hardening ([#10](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/10)) + dependency CVE fixes ([#11](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/11)) by @JF10R, tool annotations ([#14](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/14) by @bryankthompson), `download_email` ([#13](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/13) by @icanhasjonas).

This klodr fork carries all of the above forward and adds the supply-chain / path-jail / review-policy layer (see comparison table above). Credit to every PR author along the chain.
