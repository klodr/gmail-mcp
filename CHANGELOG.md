# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Placeholder for the next release cycle.

## [0.1.0] - 2026-04-22

### Added

- **Attachment jail** (`GMAIL_MCP_ATTACHMENT_DIR`, default `~/GmailAttachments/`, mode `0o700`). Every attachment path passed to `send_email` / `draft_email` / `reply_all` is `realpath`-canonicalized and rejected if it escapes the jail. Symlink-to-outside is rejected. Closes the headline prompt-injection exfiltration vector (a crafted inbound email instructing the agent to attach `~/.ssh/id_rsa` etc.).
- **Download jail** (`GMAIL_MCP_DOWNLOAD_DIR`, default `~/GmailDownloads/`, mode `0o700`). `download_email` and `download_attachment` write exclusively inside this directory. The leaf is opened with `O_NOFOLLOW` so a pre-existing symlink at the destination cannot be used to escape. Post-`mkdir` the resolved path is re-verified against the jail root (TOCTOU defense).
- **Zod schema bounds**: `SearchEmailsSchema.maxResults` ≤ 500, `ListInboxThreadsSchema.maxResults` ≤ 500, `GetInboxWithThreadsSchema.maxResults` ≤ 500 (≤ 100 when `expandThreads=true`), `Batch*EmailsSchema.messageIds` ≤ 1000, `Batch*EmailsSchema.batchSize` ≤ 100. Blocks resource-exhaustion requests.
- **Cryptographic MIME boundary**: `createEmailMessage` uses `crypto.randomBytes(16).toString('hex')` instead of `Math.random().toString(36)`. A crafted body cannot collide with the boundary and inject synthetic headers.
- **`llms-install.md`**: generic, client-agnostic install guide meant to be read by an AI assistant installing this MCP on a user's behalf.
- **OpenSSF Scorecard**, **Socket Security**, **CodeRabbit** reviews wired into CI.
- `CHANGELOG.md` (this file), `SECURITY.md`, `CONTRIBUTING.md`, `CONTINUITY.md`, `ASSURANCE_CASE.md`.
- `.github/FUNDING.yml` (GitHub Sponsors, Patreon, Ko-fi) and matching badges in the README.

### Changed (BREAKING)

- **Node.js floor: `>=20.11`** (was `>=14`). Node 18 is past EOL; the 20.11 floor is required by `import.meta.dirname` in the ESLint config.
- **Build tool**: `tsc` → `tsup` (single-file ESM bundle to `dist/index.js`). Easier Sigstore verification, smaller npm tarball, faster builds.
- **Linting**: ESLint flat config (`eslint.config.js`) with `typescript-eslint`'s `recommendedTypeChecked` preset. Prettier for formatting.
- `console.log` on the stdio transport path replaced with `console.error` (JSON-RPC framing runs over stdout; any stdout write corrupts the transport).
- README rewritten: concise klodr-style intro, 3-way comparison table against the upstream forks with explicit security-feature ticks, `Safeguards` table documenting the new env vars, upstream fork history moved to a trailing `## History` section.

### Removed

- `Dockerfile` + `docker-compose.yml` (inherited from the upstream; stdio MCP install via `npx` makes Docker unnecessary and the compose file referenced stale env-var layouts).
- `setup.js`, `Gmail-MCP-Server_Claude.ico`, `Gmail-MCP-Server_Claude.ps1` (Claude-Desktop-specific installer scaffolding from the original upstream, not used by this fork).
- `filter-examples.md` (examples absorbed into README Tools section).
- `.github/workflows/close-stale-pr-19.yml` (dead workflow from the ArtyMcLabin chain).

### Security

- Closes `@ArtyMcLabin#28` class of concern: attachment exfiltration via prompt injection on write tools.
- Closes a minor header-injection via `Math.random` boundary collision (theoretical, not exploited in the wild).
- Bumps the Node floor away from the EOL Node 18 line.

---

This repository is a fork of [GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server) via [ArtyMcLabin/Gmail-MCP-Server](https://github.com/ArtyMcLabin/Gmail-MCP-Server). Pre-fork changelog is not reproduced here — see the upstream history and the acknowledgments in the README.
