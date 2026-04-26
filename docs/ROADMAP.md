# Roadmap

Loose planning horizon of ~12 months, ordered by intent (not a commitment).

## Near-term (next release cycle)

- **MCP `outputSchema` per tool** — extend `defineTool()` with an optional `outputSchema?: ZodRawShape` parameter (`0.30.0` shipped the `inputSchema` half of the contract). Write a Zod schema for each of the 26 tools, derived from the `structuredContent` shape each handler returns today. Lets us drop the textual `RETURNS:` block from tool descriptions and rely on a machine-readable contract instead. Naturally pairs with the next minor release (`0.31.0` or similar).
- **v1.0.0 on npm** — cut once the `outputSchema` item above lands. Every release is already signed with Sigstore (keyless GitHub OIDC), ships an SLSA in-toto attestation, and carries npm provenance — the `0.x` line on npm has the same supply-chain posture, the `1.0.0` cut is purely a maturity / API-stability signal.

## Shipped (post-v0.30.0, 2026-04-26)

- ✅ **Test coverage backfill (#91)** — 18 new tests across `src/tools/messaging.ts`, `src/tools/filters.ts`, `src/tools/downloads.ts`, and the prompts surface. Brought the global statement coverage from ~81% (v0.30.0 cut) to **>93%** with 560 tests total. Branch coverage on the four registrar files went up substantially (filters.ts 67% → 81%, messages.ts 64% → 67%). Mock helpers gained `messageGetHttpError` / `attachmentGetHttpError` / `failOnIds` options to make HTTP-error and per-item-batch-failure branches reachable from tests.

## Shipped in v0.30.0 (2026-04-26)

- ✅ **Migrate `Server` (legacy) → `McpServer` (ergonomic SDK API)** — the 1300-line `CallToolRequestSchema` switch dispatcher is gone. Every tool now lives in its own module under `src/tools/*.ts`, registered through a `defineTool()` wrapper that applies the OAuth scope filter at registration time so `tools/list` is auto-emitted by the SDK. `src/index.ts` shrunk from 2124 LOC to ~370 LOC.
- ✅ **Complete code audit** — the M01-M04 medium-severity security findings shipped in v0.10.0 / v0.20.0; the v0.30.0 migration extracted every tool case into its own testable module, removed the duplicated helpers, and consolidated header parsing in `src/gmail-headers.ts`. The remaining quality findings from the four AI-agent audits are absorbed into the per-domain registrar files.
- ✅ **Test coverage on `src/index.ts`** — `src/index.ts` is now a 370-LOC entry point with no tool dispatch; the per-tool handlers live in `src/tools/*.ts` with direct E2E coverage via `Client` + `InMemoryTransport`. Global statement coverage went from ~39 % to ~81 %, well above the 70 % v1.0.0 floor.
- ✅ **Re-tighten Codecov thresholds** — `project.target: auto` + `patch.target: 95%` restored (was relaxed to 35 % / 75 % during the bridge). Shipped well before the 2026-05-15 hard deadline.
- ✅ **Recipient pairing gate** — `pair_recipient` tool + `~/.gmail-mcp/paired.json` allowlist + `requirePairedRecipients` gate on `send_email` / `reply_all` / `draft_email` / `create_filter.action.forward`. (Item shipped in v0.20.0; consolidated under the v0.30.0 registrar in `src/tools/messaging.ts`.)

## v0.10.0 — Parity release (shipped 2026-04-23)

Brought `klodr/gmail-mcp` up to the hardening baseline already shipped in the sibling MCP servers [mercury-invoicing-mcp](https://github.com/klodr/mercury-invoicing-mcp) and [faxdrop-mcp](https://github.com/klodr/faxdrop-mcp). These items landed as a group because they share a prerequisite (middleware extraction) and together constitute the hardening floor the other two repos already enforce.

- ✅ **Extract `src/middleware.ts`** — `wrapToolHandler(name, handler)` middleware mirrors `mercury-invoicing-mcp/src/middleware.ts` and `faxdrop-mcp/src/middleware.ts`. Unblocks dry-run, structuredContent, timeouts, and sanitizeForLlm without duplicating glue code in 25 switch cases.
- ✅ **`GMAIL_MCP_DRY_RUN` environment flag** — every write tool short-circuits before calling Gmail and returns the redacted payload it would have sent. Matches `MERCURY_MCP_DRY_RUN` and `FAXDROP_MCP_DRY_RUN`.
- ✅ **`sanitizeForLlm` fence** — attacker-influenced fields returned to the LLM are wrapped in `<untrusted-tool-output>…</untrusted-tool-output>` after stripping C0 control chars + zero-width + BiDi overrides (`src/sanitize.ts`).
- ✅ **60-second timeout on every Gmail API call** — `google.options({ timeout: 60_000 })` applied before the `gmail` client is constructed; every `gmail.users.*` inherits via gaxios. Tunable via `GMAIL_MCP_TIMEOUT_MS`.
- ✅ **`structuredContent` in `ToolResult`** — `attachStructuredContent` in `src/middleware.ts` now lifts JSON payloads onto the structured channel for every tool response.
- ✅ **Audit log elision** — counterparty PII (subject, to/cc/bcc, snippet) elided by default; free-form bodies (`body`, `htmlBody`) elided by length with `[ELIDED:N chars]`; opt-out via `GMAIL_MCP_AUDIT_LOG_VERBOSE=true` (`src/audit-log.ts`, shipped in #58).
- ✅ **`scripts/prod-readonly-test.mjs`** — pre-release smoke-test using a `gmail.readonly` token against `list_email_labels`, `search_emails q:in:inbox`, `read_email` (full/summary/headers_only), `list_inbox_threads`, `get_thread`, and `get_inbox_with_threads`. Spawns `node dist/index.js` over stdio + walks the read-only surface; exits non-zero on any tool error or missing data path. Shipped post-v0.30.0.
- ✅ **`SECURITY.md` expansion** — SBOM disclosure block, response-time targets, verify-release recipes, and the "Security best practices when using this MCP" section (token scoping, credential hygiene, human-in-the-loop on writes, audit-log enablement, rate-limit monitoring, jail containment, token revocation, package update cadence — 8 bullets) all landed.

## Shipped (post-v0.10.0 hardening, 2026-04-24)

- ✅ **Attachment filename neutralisation** — `sanitizeAttachmentFilename` (`src/utl.ts`) replaces POSIX / Windows separators, NUL / C0 / DEL / C1, and reserved chars with `_`, strips leading dots, and falls back to `"attachment"` on an empty or all-underscore result. Applied before `safeWriteFile` ingests any attacker-controlled filename. PRs #59 and #61.
- ✅ **Audit log PII elision by default** — `SIZE_ELIDED_KEYS` + `PII_ELIDED_KEYS` sets + `GMAIL_MCP_AUDIT_LOG_VERBOSE=true` escape hatch. PR #58.
- ✅ **Sanitize bypass early-returns** — all direct error-text returns now route through `sanitizeForLlm` instead of bypassing the fence. PR #57.
- ✅ **Protocol-error flagging on download failures** — `download_email` / `download_attachment` catch blocks now return `isError: true` and surface Gmail HTTP status via `asGmailApiError`. PR #60.
- ✅ **Graceful `invalid_grant` handling** — `buildInvalidGrantPayload` + `isInvalidGrantError` in `src/gmail-errors.ts` catch the Google-auth-library rejection and surface a stable structured payload so clients can branch on `code === "INVALID_GRANT"`. Contract:

  ```json
  {
    "code": "INVALID_GRANT",
    "message": "The Gmail refresh token was rejected by Google. It was likely revoked by the user, expired after 6 months of inactivity, or reissued elsewhere.",
    "recovery_action": "Re-run `npx @klodr/gmail-mcp auth` to reauthorise.",
    "credential_path": "~/.gmail-mcp/credentials.json"
  }
  ```

## Gmail API surface not yet wrapped

The MCP currently covers ~25 tools across messages, threads, labels, and filters. Planned additions as demand emerges; much of this catches up with the broader surface exposed by [shinzo-labs/gmail-mcp](https://github.com/shinzo-labs/gmail-mcp) (see [COMPETITORS.md](./COMPETITORS.md)).

- **Drafts CRUD** — `drafts.list`, `drafts.get`, `drafts.update`, `drafts.delete`, `drafts.send` (only `drafts.create` is wired today via `draft_email`).
- **Send-as aliases** — `settings.sendAs.*` (create / update / delete / verify) for managing Gmail aliases programmatically.
- **Vacation responder** — `settings.vacation` get/update for enabling/disabling the auto-responder.
- **Forwarding addresses** — `settings.forwardingAddresses.*`.
- **POP / IMAP settings** — `settings.pop`, `settings.imap`.
- **Delegates** — `settings.delegates.*` (list, add, remove, verify) for shared-mailbox delegation.
- **S/MIME configuration** — `settings.sendAs.smimeInfo.*` for agents that need to sign or encrypt outbound email.
- **Language preference** — `settings.language` get/update.
- **Push notifications** — `users.watch` + `users.stop` + `users.history.list` for near-real-time inbox event streaming via Cloud Pub/Sub, so an agent can react to new mail without polling.

## Ergonomic tool wrappers

Dedicated wrappers that save the agent from reconstructing MIME headers, fetching thread context, or multi-step lookups. Inspired by tools seen in [ustikya/mcp-gmail](https://github.com/ustikya/mcp-gmail) and [fernandezdiegoh/gmail-mcp](https://github.com/fernandezdiegoh/gmail-mcp) (see [COMPETITORS.md](./COMPETITORS.md)).

- **`reply_to_email`** — first-class single-recipient reply. `reply_all` exists today but forcing the agent to choose `reply_all` with manually-trimmed recipients is error-prone; a dedicated `reply_to_email` that replies to the message's `From` address only (or an explicit recipient) fills the common case cleanly and threads `In-Reply-To` / `References` automatically.
- **`forward_email`** — single-call forward that preserves the original subject with a `Fwd:` prefix, includes a quoted body, carries the attachments forward, and lets the agent add a cover note in one parameter. Today the agent has to fetch the message, assemble a new MIME, and re-upload attachments.

## Transport

- **HTTP / SSE transport alongside stdio** — track the MCP spec's move toward streamable-HTTP. When the SDK makes the HTTP transport first-class, add it as an opt-in mode (`--transport http --port …`) so the server can be self-hosted and reached by remote MCP clients. A `docker-compose.yml` example will land with this item, not before (a compose file only makes sense once there is a long-running daemon to compose).
- **Headless OAuth mode for hosted deployments** — today gmail-mcp expects a local `gcp-oauth.keys.json` file plus an interactive browser-based OAuth flow that writes `~/.gmail-mcp/credentials.json`. That's incompatible with hosted MCP runners that can only pass secrets as environment variables. Add an env-var path: `GMAIL_OAUTH_CLIENT_ID` + `GMAIL_OAUTH_CLIENT_SECRET` + `GMAIL_OAUTH_REFRESH_TOKEN`, all three pre-obtained by a one-shot `npx @klodr/gmail-mcp auth` run on the user's local machine. When all three are set, skip the file-loading + interactive-flow code paths entirely and instantiate the OAuth2 client directly from the env triplet. Doc the flow in README. Threat-model the new env vars in `.github/SECURITY.md` (the refresh_token is as sensitive as `credentials.json`).

## Discoverability

- **MCP registries** — publish the server to the public MCP indexes once v1.0.0 is cut, so agent platforms can discover it without a manual config line. Targets: the [official MCP Registry](https://github.com/modelcontextprotocol/registry), [mcp.so](https://mcp.so), [glama.ai](https://glama.ai/mcp), [smithery.ai](https://smithery.ai).

## Compliance / governance

- **Second maintainer → OpenSSF Gold** — actively welcome co-maintainership via `.github/CODEOWNERS` once a contributor has several merged PRs. Gold requires ≥2 active maintainers; that's the gating constraint.
- **MCP SDK majors** — follow the `@modelcontextprotocol/sdk` major-version train; migrate to Zod v4-only idioms once the SDK floor allows.
