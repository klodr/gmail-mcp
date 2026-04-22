# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.0] - 2026-04-22

First tagged release of `klodr/gmail-mcp`. Sets a high version floor to reflect
the hardening and test maturity accumulated post-fork; 1.0.0 is reserved for
the pending `src/index.ts` handler extraction that unblocks real coverage on
the 25-tool dispatcher (tracked in `ROADMAP.md`).

### Added

#### Security boundaries

- **Attachment jail** (`GMAIL_MCP_ATTACHMENT_DIR`, default `~/GmailAttachments/`, mode `0o700`). Every attachment path passed to `send_email` / `draft_email` / `reply_all` is `realpath`-canonicalized and rejected if it escapes the jail. Symlink-to-outside is rejected. Closes the headline prompt-injection exfiltration vector (a crafted inbound email instructing the agent to attach `~/.ssh/id_rsa` etc.).
- **Download jail** (`GMAIL_MCP_DOWNLOAD_DIR`, default `~/GmailDownloads/`, mode `0o700`). `download_email` and `download_attachment` write exclusively inside this directory. The leaf is opened with `O_NOFOLLOW` so a pre-existing symlink at the destination cannot be used to escape. Post-`mkdir` the resolved path is re-verified against the jail root (TOCTOU defense).
- **Outbound email cap** — `send_email` (and the `reply_all` variant) is now hard-limited to **400 emails/day and 6000/month per install**. An attempt beyond the cap is rejected locally with a `retry_after` hint rather than ever reaching Gmail, so a prompt-injected agent cannot quietly burn the account's Gmail send quota (2000/day for standard accounts, 500/day for trial) before the operator notices.
- **Per-bucket write rate limiter** (`GMAIL_MCP_RATE_LIMIT_<bucket>=D/day,M/month`, kill-switch `GMAIL_MCP_RATE_LIMIT_DISABLE=true`). The send cap above is the headline case; the full default matrix is `send` 400/6000, `delete` 200/2000, `modify` 500/5000, `drafts` 300/3000, `labels` 50/500, `filters` 20/200 — every write verb has its own bucket so a loop on one doesn't eat the budget of another. State persisted in `GMAIL_MCP_STATE_DIR/ratelimit.json` (mode `0o600`). The retry-after value is computed via `Math.min` over the window to stay correct across concurrent processes.
- **Opt-in redacted JSONL audit log** (`GMAIL_MCP_AUDIT_LOG=/abs/path/audit.jsonl`, mode `0o600`). Every tool call is appended with redacted args; keys on an allowlist pass through, everything else is elided with a length marker, credentials are replaced with `[REDACTED]`. Off by default.
- **Zod schema bounds**: `SearchEmailsSchema.maxResults` ≤ 500, `ListInboxThreadsSchema.maxResults` ≤ 500, `GetInboxWithThreadsSchema.maxResults` ≤ 500 (≤ 100 when `expandThreads=true`), `Batch*EmailsSchema.messageIds` ≤ 1000, `Batch*EmailsSchema.batchSize` ≤ 100. Blocks resource-exhaustion requests.
- **`GmailIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/)`** applied to every Gmail ID field (`messageId`, `threadId`, `labelId`, `attachmentId`, `filterId`, array variants) in `src/tools.ts`. Blocks megabyte-sized IDs that would burn a round-trip and leak their prefix through the batch-error logger.
- **Cryptographic MIME boundary**: `createEmailMessage` uses `crypto.randomBytes(16).toString('hex')` instead of `Math.random().toString(36)`. A crafted body cannot collide with the boundary and inject synthetic headers.
- **`safeWriteFile`** switched from `O_CREAT | O_TRUNC` to `O_CREAT | O_EXCL`, preventing a silent overwrite of a user file sharing a name with an incoming attachment. New `onCollision: "error" | "suffix"` option; `download_email` / `download_attachment` handlers opt into `"suffix"` which appends ` (1)`, ` (2)`, … like browsers do.
- **`createEmailWithNodemailer`** now runs every user-supplied header value through `sanitizeHeaderValue` (from/to/cc/bcc/subject/inReplyTo/references). Previously the attachment path delegated CRLF sanitization to nodemailer; in-tree enforcement means a nodemailer regression cannot silently reopen the injection vector.

#### Protocol surface

- **6 user-facing slash commands / prompts** for common inbox flows (`unread-emails`, `unread-stale`, `inbox-reclass`, `detect-phishing`, `detect-spam`, `unread-triage`). Registered via `server.registerPrompt` with Zod-validated argument schemas.
- **MCP Registry manifest** (`server.json`) so the server is discoverable via the MCP Registry index. `scripts/sync-version.mjs` keeps `server.json`, `package.json`, and the `Server(...)` literal in `src/index.ts` in lock-step.
- **`llms-install.md`** — generic, client-agnostic install guide meant to be read by an AI assistant installing this MCP on a user's behalf.

#### Supply-chain & release

- **Sigstore-signed `dist/index.js` + SLSA in-toto attestation** on every release tag; npm publishes with provenance.
- **SBOMs on every release**: SPDX 2.3 and CycloneDX 1.5, each uploaded as a Sigstore bundle so auditors can verify the bill-of-materials came from this repo's release workflow and nothing else.
- **Single-file `tsup` ESM bundle** — smaller tarball, easier Sigstore verification than a `tsc` tree.
- **OpenSSF Scorecard** weekly scan + badge.
- **Socket Security** supply-chain alerts on every PR.
- **CodeRabbit** assertive reviews on every PR.
- **Qodo Merge dual reviewer** workflow — `qodo-ai/pr-agent@v0.34` pinned by SHA, two parallel jobs running DeepSeek R1 (reasoner) + Gemini 3.1 Pro Preview (thinking). Triangulates CR's GPT lineage with two independent model families. Skips drafts and fork PRs; 15-min timeout; `persistent_comment=false` so each model's review lands in its own comment.
- **CodeQL Advanced** (`javascript-typescript` + `actions` categories).
- **Dependabot** watching `npm` and `github-actions` ecosystems.
- **Shell-injection-safe GitHub Actions workflows** across the board.
- **Docker build workflow** (`docker.yml`) — `Dockerfile` kept in-tree alongside the `npx` install path; the ROADMAP's Node-22 migration step pins a Dockerfile digest as part of its scope.
- `CODEOWNERS`, issue and pull-request templates, `.github/FUNDING.yml` (GitHub Sponsors, Patreon, Ko-fi), matching README badges.

#### Test surface

- **Statement coverage more than doubled vs. the parent fork**: 16.14% on `ArtyMcLabin/Gmail-MCP-Server` (97 tests) → **>42%** here (260+ tests), and the absolute number moves in lock-step — `vitest.config.ts` now forces `coverage.include: ["src/**/*.ts"]` so untested files register as 0% instead of being silently excluded by v8 and inflating the headline number.
- Unit and property tests added for `gmail-errors.ts`, `scopes.ts`, `label-manager.ts`, `filter-manager.ts`, `rate-limit.ts`, `audit-log.ts`, `prompts.ts`.
- **Fast-check property-based fuzz suite** on the redaction / sanitizer paths.
- **Hardening-specific test file** covering jails, CRLF, `O_EXCL` / `O_NOFOLLOW`, boundary crypto.
- TOCTOU-safe file reads in rate-limit + audit-log tests via `openSync + fstatSync + readSync` on a single fd (closes a CodeQL class).

#### Documentation

- **`SECURITY.md`** — detailed threat model, OAuth-keys `0o600` guarantee, `safeWriteFile` no-silent-overwrite behaviour.
- **`CONTRIBUTING.md`**, **`CONTINUITY.md`**, **`ASSURANCE_CASE.md`**, **`ROADMAP.md`**.
- README rewritten: concise intro, 3-way comparison table against the upstream forks with explicit security-feature ticks, `Safeguards` table documenting every env var, upstream fork history moved to a trailing `## History` section. Now annotates each Node.js floor with LTS/EOL status and surfaces statement coverage.

### Changed (BREAKING)

- **Node.js floor: `>=20.11`** (was `>=14`). Node 18 is past EOL; the 20.11 floor is required by `import.meta.dirname` in the ESLint config. Bump to Node 22 tracked in `ROADMAP.md` (Node 20 EOL 2026-04-30).
- **Build tool**: `tsc` → `tsup` (single-file ESM bundle to `dist/index.js`).
- **Linting**: ESLint flat config (`eslint.config.js`) with `typescript-eslint`'s `recommendedTypeChecked` preset. Prettier for formatting.
- `console.log` on the stdio transport path replaced with `console.error` (JSON-RPC framing runs over stdout; any stdout write corrupts the transport).

### Removed

- Inherited `CLAUDE.md` + `.claude/skills/` (ArtyMcLabin's internal SOP, not applicable to `klodr/`).
- `setup.js`, `Gmail-MCP-Server_Claude.ico`, `Gmail-MCP-Server_Claude.ps1` (Claude-Desktop-specific installer scaffolding from the original upstream, not used by this fork).
- `filter-examples.md` (examples absorbed into README Tools section).
- `.github/workflows/close-stale-pr-19.yml` (dead workflow from the ArtyMcLabin chain).

### Security

- Closes `@ArtyMcLabin#28` class of concern: attachment exfiltration via prompt injection on write tools.
- Mitigates a minor header-injection vector via `Math.random` boundary collision (theoretical, not exploited in the wild).
- Addresses a credential-leak path in `loadCredentials`: previously logged the full `Error` object, whose `JSON.parse` failure message could carry a snippet of a partially-corrupted OAuth file including `client_secret`. Now logs `error.message` only.
- Adds a copy-mode enforcement for OAuth keys: `fs.copyFileSync(localOAuthPath, OAUTH_PATH)` is now followed by `chmodSync(OAUTH_PATH, 0o600)`. `copyFileSync` preserves the source mode, so a user-provided `gcp-oauth.keys.json` with `0o644` would have kept that mode in `~/.gmail-mcp/`. Aligns with the `0o600` guarantee already held for `credentials.json`.
- Bumps the Node floor away from the EOL Node 18 line.

---

This repository is a fork of [GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server) via [ArtyMcLabin/Gmail-MCP-Server](https://github.com/ArtyMcLabin/Gmail-MCP-Server). Pre-fork changelog is not reproduced here — see the upstream history and the acknowledgments in the README.
