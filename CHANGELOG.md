# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Recipient pairing gate** — opt-in allowlist that caps the blast radius of a prompt-injection-driven `send_email` / `reply_all` / `draft_email` call. When `GMAIL_MCP_RECIPIENT_PAIRING=true`, every `To` / `Cc` / `Bcc` address must appear in `~/.gmail-mcp/paired.json` (mode `0o600`, override via `GMAIL_MCP_PAIRED_PATH`). Manage the list via the new `pair_recipient` tool (`action: "add" | "remove" | "list"`). Feature is OFF by default; legacy users see no change. Tracked in `ROADMAP.md` → v1.0.0 block.

### Changed

- **`download_email` parallelises the Gmail metadata + raw-EML fetches** when `format: "eml"` is requested. The prior implementation awaited `format: "full"` first, then awaited `format: "raw"` serially — two sequential round-trips to Gmail for every EML download. `Promise.all` now issues both in parallel, halving the user-visible latency on EML saves. `json` / `txt` / `html` paths are unchanged — they never needed the second fetch.
- **`attachStructuredContent` pre-filters non-JSON text before `JSON.parse`** — the middleware hot-path now checks the first non-whitespace character against `{` / `[` and short-circuits when it is neither, instead of relying on `try/catch` to reject plain-prose tool responses. Equivalent semantics; cheaper on tools that do not emit JSON (read_email text, summary-style outputs). `src/middleware.test.ts` contract unchanged.
- **Three error-surface catches in `src/index.ts`** (`send_email` attachments logging, `download_email`, `download_attachment`) now consume `asGmailApiError` from `src/gmail-errors.ts` instead of open-coding `error instanceof Error ? error.message : String(error)`. User-facing failure messages now include the Gmail HTTP status when available (`"Failed to download email (HTTP 404): Message not found"`), matching the pattern already in `src/label-manager.ts` and `src/filter-manager.ts`.

## [0.10.0] - 2026-04-23

### Fixed

- **CodeQL Code Scanning alert #28** (`src/sanitize.ts`) — the control-character stripping regex now compiles via `new RegExp(<string>)` with explicit `\uXXXX` escapes, rather than a literal regex with raw high-bit codepoints. Functionally identical, but the literal form tripped `js/overly-large-range` on CodeQL's scanner because the UTF-8 sequences read as an unbounded range byte-for-byte. No runtime behaviour change; same control/zero-width/BiDi set covered. Mirrors the fix landed on `klodr/mercury-invoicing-mcp` PR #75.

### Changed

- **Node.js floor pinned to exact `>=22.22.2`** (was `>=22.22`, originally `>=22.11`). The previous `>=22.22` range accepted `22.22.0` and `22.22.1`, which predate the seven CVEs fixed in `22.22.2` (two high-severity: TLS/SNI callback handling and HTTP header validation; three medium, two low). Pinning to the exact patch closes the gap so a fresh `npm install` cannot land on a pre-CVE runtime. Aligned with `klodr/faxdrop-mcp` (shipped in PR #71), `klodr/mercury-invoicing-mcp`, and the private `klodr/relayfi-mcp`. Also updates `SECURITY.md` "Supported runtimes", `llms-install.md` prerequisite, and `.github/dependabot.yml` `@types/node` major-clamp comment.

### Fixed

- **60-second hard timeout on every Gmail API call** — `google.options({ timeout: 60_000 })` is now applied before the `gmail` client is constructed, so every `gmail.users.*` call inherits the cap via gaxios. Without this, a slow Gmail response would hang the MCP stdio session with no way for the client to recover short of killing the process (v0.10.0 parity item — mercury has a 30 s cap at `src/client.ts:72`, faxdrop relies on upstream response headers). **60 s rather than 30 s** because gmail has two slow-path surfaces mercury lacks: a 25 MB attachment upload on `send_email` (base64-encoded + single POST) routinely pushes past 30 s on a mid-tier mobile uplink, and non-US clients add 200–500 ms per round-trip compounded across gaxios's internal redirects. The ceiling is tunable further via the `GMAIL_MCP_TIMEOUT_MS` env var for mailboxes where a single `messages.list` with a heavy `q:` legitimately runs long.

### Added

- **Codecov Test Analytics wiring** — vitest emits a `test-results.junit.xml` alongside its default human reporter, and CI uploads it via `codecov/codecov-action@v6.0.0` (pinned by SHA) invoked with `report_type: test_results`. Gives us the "Tests" dashboard on codecov.io: per-suite flaky-test detection, slowest tests, per-test failure history. Upload runs only on the Node 22 matrix leg with `if: ${{ always() && matrix.node == '22' && !cancelled() }}` so failed test runs still surface the report (where flaky-test data is most useful) while cancelled workflows don't push phantom results. XML file is in `.gitignore` and absent from `package.json#files` — it never ships to npm. Mirrors the wiring already shipped in sibling repos `klodr/mercury-invoicing-mcp` (v0.9.2) and `klodr/faxdrop-mcp` (v0.3.8).
- **`src/middleware.ts` — extracted rate-limit + audit-log helper** (`wrapToolHandler`). Mirrors the design already shipped in `mercury-invoicing-mcp/src/middleware.ts:359` and `faxdrop-mcp/src/middleware.ts:203`. The helper preserves the observable audit trail of the current inline wiring in `src/index.ts` (three terminal states: `ok`, `error`, `rate_limited`) and the `mcp_safeguard` / `mcp_rate_limit_*_exceeded` error-payload shape, so the wire-up PR can be reviewed as a pure structural refactor on top of an already-merged and tested helper. Unblocks the v0.10.0 parity layers (`AbortSignal.timeout`, `sanitizeForLlm` fence, dry-run, `structuredContent`) without having to duplicate glue code in every switch case. Covered by 6 unit tests in `src/middleware.test.ts`.

## [0.9.2] - 2026-04-23

### Changed

- **Node.js floor tightened to `>=22.11`** (was `>=22`). `22.11.0` is the LTS-tagged entry point for the Node 22 "Jod" line (October 2024); the previous `>=22` would have accepted the pre-LTS `22.0`–`22.10` releases which predate the LTS designation. Aligned with the sibling repos `klodr/faxdrop-mcp` and `klodr/mercury-invoicing-mcp`, all moving to the same floor.
- `.github/dependabot.yml` `@types/node` major-version-clamp comment aligned to the new `>=22.11` floor.
- `llms-install.md` prerequisite updated to **Node.js ≥ 22.11**.
- `SECURITY.md` "Supported runtimes" section updated to state `Node.js ≥ 22.11` with the LTS-tag rationale.

### Added

- **`.npmrc` with `engine-strict=true`** — aligns with sibling repos `klodr/faxdrop-mcp` and `klodr/mercury-invoicing-mcp`. The manifest's `engines.node: >=22.11` is enforced as a hard `npm install` failure rather than a soft warning, so someone trying to install under Node 20 sees a blocking error instead of the package installing silently and crashing at runtime on an ES2024 intrinsic. No effect on consumers who already run Node 22+.
- **`read_email` now respects Gmail's 102 KB clip threshold** (upstream GongRzhe#33). Previously a multi-MB newsletter body was returned verbatim and blew past the 25k-token MCP response cap, making the tool unusable on Gmail content of that size. The handler now clips the body at 102 KB (104 448 bytes, matching Gmail's own web-UI threshold) and emits the `[Message clipped — N KB more. Gmail clips at 102 KB in its own UI. Call download_email(…) for the full payload …]` marker so an agent has a concrete next step.

  Three new optional parameters on `ReadEmailSchema`:
  - `format`: `"full"` (default) / `"summary"` (500-byte cap, no attachments) / `"headers_only"` (no body, no attachments).
  - `maxBodyLength`: byte cap, default `104448` (102 KB), max `1048576` (1 MB), set to `0` to disable. Coerces from stringified digits for strict-JSON clients.
  - `includeAttachments`: `true` by default; drop the metadata list when you know the message has many attachments and you don't want them in the response.

  Truncation slices on a UTF-8 byte boundary and drops any trailing replacement character so a truncated emoji or accent doesn't leave a stray U+FFFD.

### Fixed

- **`delete_email` / `batch_delete_emails` required scope corrected to `mail.google.com`** (upstream GongRzhe#47). The two tools were gated on `gmail.modify`, but the Google API `users.messages.delete` endpoint specifically rejects `gmail.modify` with HTTP 403 "Insufficient Permission" — only the legacy `mail.google.com` scope authorizes permanent delete (`gmail.modify` stops at moving to Trash). The bug was silently carried from upstream: the tool was advertised to LLMs but every invocation failed at Google. Users who need permanent delete now authenticate with `--scopes=mail.google.com,gmail.settings.basic` (or add `mail.google.com` to their existing scopes). Users who don't need it keep the default `gmail.modify` floor and the two delete tools are correctly filtered out of the registered tool list at startup.
- **`SCOPE_MAP` gained `mail.google.com`** pointing to the legacy bare URL `https://mail.google.com/` (the only Google scope not served under `https://www.googleapis.com/auth/…`).
- **Outgoing `From:` header now carries the display name** (upstream GongRzhe#77). When the caller doesn't pass an explicit `from`, `send_email` / `draft_email` / `reply_all` resolved it to the literal string `"me"` which Gmail accepts on the envelope side but renders as a bare email address in the recipient's inbox — `bob@example.com` instead of `Bob Smith <bob@example.com>`.

  The new `src/sender-resolver.ts` module resolves a proper `"DisplayName <email>"` once per gmail-client instance via `users.settings.sendAs.list` (falls back to `users.getProfile` on `gmail.send`-only scope, then to the old `"me"` sentinel as a last resort). Result is cached in a WeakMap keyed by the client, so two gmail clients signed in to different accounts in the same process never cross-contaminate (Qodo flagged the original module-level cache on PR #42 as multi-account unsafe). A second WeakMap dedups concurrent cold-cache calls so three parallel sends on a fresh client share one `sendAs.list` round-trip instead of each firing their own. The `"me"` sentinel is intentionally NOT cached so a process that re-auths that client to a broader scope picks up the display name on the next send without a restart.
- **Tool arguments now tolerate JSON-stringified values from strict-JSON MCP clients** (upstream GongRzhe#95 / #96). Some MCP clients — the Claude Code SDK is the one the upstream issues are written against — serialize tool parameters strictly as JSON, so an `array` field arrives as the literal string `'["a","b"]'` and a `number` field as the digit string `"10"`. Bare `z.array(...)` / `z.number()` schemas then reject the call with "Expected array, received string" and the tool becomes unusable from that client.

  Every array-typed field (`to` / `cc` / `bcc` / `attachments` / `labelIds` / `addLabelIds` / `removeLabelIds` / `messageIds` across send, modify, batch-modify, batch-delete) now accepts either a native array or a JSON-stringified array literal (the string must start with `[` to trigger the `JSON.parse` fast-path — a plain comma-separated list like `"foo,bar"` still surfaces Zod's "expected: array" error, which is more useful to the caller than an opaque "Unexpected token" from a parse attempt). Every numeric field (`maxResults`, `batchSize`, `maxBodyLength`) now uses a scoped `coerceInt(…)` helper that rescues stringified digits (`"10"` → `10`) but — unlike `z.coerce.number()` — does NOT silently widen `true`/`false`/`null`/`[]` into `1`/`0`/`0`/`0`. Non-string non-number inputs fall through to `z.number().int()` and surface the expected "Expected number" error (Qodo finding on PR #40).

  **Tightening notes on byte-size fields (Qodo re-raise + CR re-raise)**: `CreateFilterSchema.criteria.size` and `CreateFilterFromTemplateSchema.parameters.sizeInBytes` now use `coerceInt({ min: 0 })` instead of the prior `z.coerce.number()`, so they reject non-integer and negative inputs (e.g., `1024.5`, `-1`). Gmail filter byte counts are always non-negative integers — a caller sending a float or negative was already shipping garbage to the Gmail API — but the schema surface is technically stricter now. Regression tests added in `src/tools-coercion.test.ts`.

  **Intentional limits of `coerceInt`** (not deemed regressions): `"1e3"` (scientific notation) and `"0xA"` (hex) are rejected by the stricter `^-?\d+$` preprocess regex. A strict-JSON client serialising a number always emits its decimal form (`1000`, not `"1e3"`), so the coercion surface is narrowed deliberately to decimal-digit strings. Malformed JSON array strings that start with `[` (e.g., `"[invalid"`) fall through to Zod's "expected array" error rather than surfacing the `JSON.parse` exception — this keeps the error shape consistent with the non-stringified case and avoids an "Unexpected token" that would confuse a caller who never intended JSON encoding.

  Regression tests in `src/tools-coercion.test.ts` pin the new behaviour so a future refactor dropping the helpers back to `z.array(...)` / `z.number()` fails immediately.
- **HTML-fallback marker is now consistent across all three reading surfaces** (Qodo finding on PR #41). When `pickBody` falls back to the HTML part (empty text, placeholder stub, or text-much-shorter-than-html heuristic), `read_email` prepends a `[Note: This email is HTML-formatted. Rendering the HTML body because the plain-text part was empty or a placeholder stub.]` marker so the LLM can calibrate its parsing. Before this fix, `get_thread` and `get_inbox_with_threads` used the same `pickBody` heuristic but silently returned the HTML body with no marker — an agent reading a thread saw different output shape for the same underlying message depending on which tool it called. Both handlers now use the new `pickBodyAnnotated` helper from `src/utl.ts` which bakes the marker in; the marker string itself is exported as `HTML_FALLBACK_NOTE` so a future change is a single-line edit. The placeholder-detection regex also accepts smart-apostrophe `can’t` (U+2019) alongside the straight `can't` (U+0027) form (CR nitpick on PR #41).

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
