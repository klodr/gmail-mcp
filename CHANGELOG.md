# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Node.js floor tightened to `>=22.11`** (was `>=22`). `22.11.0` is the LTS-tagged entry point for the Node 22 "Jod" line (October 2024); the previous `>=22` would have accepted the pre-LTS `22.0`–`22.10` releases which predate the LTS designation. Aligned with the sibling repos `klodr/faxdrop-mcp` and `klodr/mercury-invoicing-mcp`, all moving to the same floor.
- `.github/dependabot.yml` `@types/node` major-version-clamp comment aligned to the new `>=22.11` floor.
- `llms-install.md` prerequisite updated to **Node.js ≥ 22.11**.
- `SECURITY.md` "Supported runtimes" section updated to state `Node.js ≥ 22.11` with the LTS-tag rationale.

### Fixed

- **HTML-fallback marker is now consistent across all three reading surfaces** (Qodo finding on PR #41). When `pickBody` falls back to the HTML part (empty text, placeholder stub, or text-much-shorter-than-html heuristic), `read_email` prepends a `[Note: This email is HTML-formatted. Rendering the HTML body because the plain-text part was empty or a placeholder stub.]` marker so the LLM can calibrate its parsing. Before this fix, `get_thread` and `get_inbox_with_threads` used the same `pickBody` heuristic but silently returned the HTML body with no marker — an agent reading a thread saw different output shape for the same underlying message depending on which tool it called. Both handlers now use the new `pickBodyAnnotated` helper from `src/utl.ts` which bakes the marker in; the marker string itself is exported as `HTML_FALLBACK_NOTE` so a future change is a single-line edit.

### Added

- **`read_email` now respects Gmail's 102 KB clip threshold** (upstream GongRzhe#33). Previously a multi-MB newsletter body was returned verbatim and blew past the 25k-token MCP response cap, making the tool unusable on Gmail content of that size. The handler now clips the body at 102 KB (104 448 bytes, matching Gmail's own web-UI threshold) and emits the `[Message clipped — N KB more. Gmail clips at 102 KB in its own UI. Call download_email(…) for the full payload …]` marker so an agent has a concrete next step.

  Three new optional parameters on `ReadEmailSchema`:
  - `format`: `"full"` (default) / `"summary"` (500-byte cap, no attachments) / `"headers_only"` (no body, no attachments).
  - `maxBodyLength`: byte cap, default `104448` (102 KB), max `1048576` (1 MB), set to `0` to disable. Coerces from stringified digits for strict-JSON clients.
  - `includeAttachments`: `true` by default; drop the metadata list when you know the message has many attachments and you don't want them in the response.

  Truncation slices on a UTF-8 byte boundary and drops any trailing replacement character so a truncated emoji or accent doesn't leave a stray U+FFFD.

### Fixed

- **`delete_email` / `batch_delete_emails` required scope corrected to `mail.google.com`** (upstream GongRzhe#47). The two tools were gated on `gmail.modify`, but the Google API `users.messages.delete` endpoint specifically rejects `gmail.modify` with HTTP 403 "Insufficient Permission" — only the legacy `mail.google.com` scope authorizes permanent delete (`gmail.modify` stops at moving to Trash). The bug was silently carried from upstream: the tool was advertised to LLMs but every invocation failed at Google. Users who need permanent delete now authenticate with `--scopes=mail.google.com,gmail.settings.basic` (or add `mail.google.com` to their existing scopes). Users who don't need it keep the default `gmail.modify` floor and the two delete tools are correctly filtered out of the registered tool list at startup.
- **`SCOPE_MAP` gained `mail.google.com`** pointing to the legacy bare URL `https://mail.google.com/` (the only Google scope not served under `https://www.googleapis.com/auth/…`).

## [0.9.1] - 2026-04-22

Single focus: move the whole toolchain off Node 20 ahead of its 2026-04-30 end-of-life. Not a feature release — the `dist/index.js` behaviour is unchanged versus 0.9.0.

### Changed (BREAKING)

- **Node.js floor: `>=22`** (was `>=20.11`). Node 20 reaches end-of-life on 2026-04-30; keeping the floor there would ship 0.9.0-era packages on an unmaintained runtime the day after. Node 22 is in Maintenance LTS through 2027-04-30, which gives a year of headroom before the next cadence bump.
- **Compile target: `ES2024`** (was `ES2022`). Node 22 implements the full ES2024 surface (`Object.groupBy`, `Map.groupBy`, `Promise.withResolvers`, iterator helpers, etc.) — the TypeScript `target` and `lib` now match, so stdlib additions don't need polyfills.
- **Bundle target: `tsup target: node22`** (was `node20`). Without this the bundler was still down-levelling Node 22 intrinsics (WebCrypto globals, `AbortSignal.any`) and the shipped `dist/index.js` wasn't actually taking advantage of the higher floor we just set.

### Changed

- `@types/node` bumped from `^20.19.39` to `^22.19.17` so the TypeScript definitions line up with the runtime floor.
- CI matrix dropped Node 20 — builds now run on Node 22 + 24. The coverage-upload step (Codecov) moved from Node 20 to Node 22.
- Release and verify-release workflows set up Node 22 (`setup-node node-version: "22"`).
- Dockerfile base image pinned to `node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f` (digest resolved via Docker Hub API at release time).
- `package-lock.json` refreshed via `npm update` — minor bumps within existing carets (`typescript-eslint` 8.58 → 8.59, etc.), no semver-major shifts.

### Added

- `.nvmrc` with `22` so `nvm use` in a fresh checkout matches `engines.node` and the CI matrix without guessing.
- `SECURITY.md` gained a **Supported runtimes** section stating the Node 22 floor and the LTS window. Existing "Verifying releases (once v1 is out)" section retitled to "Verifying releases" — v0.9.0 being already on npm, the future tense no longer applies.
- `ROADMAP.md` item **Node.js 22 migration** ticked off; **Optional audit log** also removed (shipped in 0.9.0 as `GMAIL_MCP_AUDIT_LOG`).
- README comparison-table tweaks: Node-floor cells marked ❌/❌/✅ for readability, published-on-npm cells deduplicated (package names were already in the GitHub-repo row), statement coverage refreshed to `>45%` (was `>42%`), `tsup` ESM-bundle cell now notes the `node22` + `ES2024` target.
- Issue-template `bug_report.yml` / `dependabot.yml` / `CONTINUITY.md` / `ASSURANCE_CASE.md` scrubbed of stray Node 20 / `20.11` references.

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
