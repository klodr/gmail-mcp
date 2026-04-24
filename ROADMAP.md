# Roadmap

Loose planning horizon of ~12 months, ordered by intent (not a commitment).

## Near-term (next release cycle)

- **Complete code audit** — *in progress, 2026-04-23/24*. This fork inherits code from two upstream chains (GongRzhe → ArtyMcLabin) and still carries patterns, dead branches, and duplicated helpers from both. A single pass through every file in `src/`, with the security-hardening posture as the baseline, to remove what is not used, consolidate what is duplicated, and document what remains non-obvious. Not a rewrite — a cleanup. Four AI-agent audits have run against v0.10.0 (security-code-reviewer, migration planner, quality reviewer, historical Explore); the M01-M04 medium-severity security findings have all shipped (`fix/sanitize-bypass-early-returns` #57, `fix/audit-elision-pii` #58, `fix/attachment-filename-sanitize` #59, `refactor/quality-top3-audit` #60). The remaining ~25 quality findings land in follow-up refactor PRs. Blocks v1.0.0.
- **Test coverage on `src/index.ts`** — the single `CallToolRequestSchema` dispatcher + its 25 tool cases + the OAuth callback path are currently 0% covered (the file is untouched by tests; global statement coverage sits at ~39% because everything else is ≥ 93%). Raising this requires either a refactor that pulls each tool-case body into a directly-callable helper (preferred) or a mocked-googleapis integration pass (heavier). Target: global statement coverage ≥ 70% before v1.0.0, ideally ≥ 85%.
- **Re-tighten Codecov thresholds — deadline 2026-05-15** — `codecov.yml` was temporarily relaxed (`project.target: 35%` / `patch.target: 75%`) when the vitest coverage scope was corrected to include every `src/**/*.ts` (previously v8 silently omitted un-imported files, inflating the apparent global to ~93%). The loosened gate is a bridge. Once the handler-extraction refactor lands and global coverage climbs back to ≥ 80%, bump `project.target` back to `auto` with `threshold: 0.5%`, and `patch.target` back to `95%` with `threshold: 1.5%`. Hard deadline so the relaxed config doesn't drift into permanent tolerance.
- **v1.0.0 on npm** — cut the first tagged release of `@klodr/gmail-mcp` once the audit and the parity + ergonomics items below land on `main`; every release is signed with Sigstore (keyless GitHub OIDC), ships an SLSA in-toto attestation, and carries npm provenance.
- **Recipient pairing gate** — add a `pair_recipient` tool and a `~/.gmail-mcp/paired.json` allowlist so `send_email` / `reply_all` / `draft_email` refuse to email an address the human has never approved, capping the blast radius of a prompt-injected `send_email` call.
- **Migrate `Server` (legacy) → `McpServer` (ergonomic SDK API)** — the server is instantiated via the low-level `new Server(..., { capabilities: { tools: {} } })` pattern inherited from the GongRzhe → ArtyMcLabin fork chain. `CallToolRequestSchema` dispatches through a 1300-line switch over 25 tool cases, capabilities are declared by hand, and Zod → JSON Schema conversion is explicit. The modern `McpServer` API (already used by mercury-invoicing-mcp and faxdrop-mcp) replaces all of that with `server.registerTool(name, { description, inputSchema }, handler)` and `server.registerPrompt(...)` — capabilities auto-declared, dispatch/validation handled by the SDK, shorter error surface. The migration folds naturally into the **Complete code audit** item above: extract each tool-case into its own handler module (→ testable directly, unblocks the 70%+ coverage target), then register them against an `McpServer`. Hold until those two items are scheduled together.
## v0.10.0 — Parity release (shipped 2026-04-23)

Brought `klodr/gmail-mcp` up to the hardening baseline already shipped in the sibling MCP servers [mercury-invoicing-mcp](https://github.com/klodr/mercury-invoicing-mcp) and [faxdrop-mcp](https://github.com/klodr/faxdrop-mcp). These items landed as a group because they share a prerequisite (middleware extraction) and together constitute the hardening floor the other two repos already enforce.

- ✅ **Extract `src/middleware.ts`** — `wrapToolHandler(name, handler)` middleware mirrors `mercury-invoicing-mcp/src/middleware.ts` and `faxdrop-mcp/src/middleware.ts`. Unblocks dry-run, structuredContent, timeouts, and sanitizeForLlm without duplicating glue code in 25 switch cases.
- ✅ **`GMAIL_MCP_DRY_RUN` environment flag** — every write tool short-circuits before calling Gmail and returns the redacted payload it would have sent. Matches `MERCURY_MCP_DRY_RUN` and `FAXDROP_MCP_DRY_RUN`.
- ✅ **`sanitizeForLlm` fence** — attacker-influenced fields returned to the LLM are wrapped in `<untrusted-tool-output>…</untrusted-tool-output>` after stripping C0 control chars + zero-width + BiDi overrides (`src/sanitize.ts`).
- ✅ **60-second timeout on every Gmail API call** — `google.options({ timeout: 60_000 })` applied before the `gmail` client is constructed; every `gmail.users.*` inherits via gaxios. Tunable via `GMAIL_MCP_TIMEOUT_MS`.
- ✅ **`structuredContent` in `ToolResult`** — `attachStructuredContent` in `src/middleware.ts` now lifts JSON payloads onto the structured channel for every tool response.
- ✅ **Audit log elision** — counterparty PII (subject, to/cc/bcc, snippet) elided by default; free-form bodies (`body`, `htmlBody`) elided by length with `[ELIDED:N chars]`; opt-out via `GMAIL_MCP_AUDIT_LOG_VERBOSE=true` (`src/audit-log.ts`, shipped in #58).
- ⬜ **`scripts/prod-readonly-test.mjs`** — pre-release smoke-test using a `gmail.readonly` token against `list_email_labels`, `search_emails q:in:inbox`, and a handful of message reads. Mercury has it, gmail does not yet. Still open.
- ⬜ **`SECURITY.md` expansion** — SBOM disclosure block, response-time targets, verify-release recipes all landed. Remaining: "Security best practices when using this MCP" section covering token scoping, host-side filesystem containment, and audit-log consumption for LLM-host operators. Still open.

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

The MCP currently covers ~25 tools across messages, threads, labels, and filters. Planned additions as demand emerges; much of this catches up with the broader surface exposed by [shinzo-labs/gmail-mcp](https://github.com/shinzo-labs/gmail-mcp) (see [COMPETITORS.md](./docs/COMPETITORS.md)).

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

Dedicated wrappers that save the agent from reconstructing MIME headers, fetching thread context, or multi-step lookups. Inspired by tools seen in [ustikya/mcp-gmail](https://github.com/ustikya/mcp-gmail) and [fernandezdiegoh/gmail-mcp](https://github.com/fernandezdiegoh/gmail-mcp) (see [COMPETITORS.md](./docs/COMPETITORS.md)).

- **`reply_to_email`** — first-class single-recipient reply. `reply_all` exists today but forcing the agent to choose `reply_all` with manually-trimmed recipients is error-prone; a dedicated `reply_to_email` that replies to the message's `From` address only (or an explicit recipient) fills the common case cleanly and threads `In-Reply-To` / `References` automatically.
- **`forward_email`** — single-call forward that preserves the original subject with a `Fwd:` prefix, includes a quoted body, carries the attachments forward, and lets the agent add a cover note in one parameter. Today the agent has to fetch the message, assemble a new MIME, and re-upload attachments.

## Transport

- **HTTP / SSE transport alongside stdio** — track the MCP spec's move toward streamable-HTTP. When the SDK makes the HTTP transport first-class, add it as an opt-in mode (`--transport http --port …`) so the server can be self-hosted and reached by remote MCP clients. A `docker-compose.yml` example will land with this item, not before (a compose file only makes sense once there is a long-running daemon to compose).

## Discoverability

- **MCP registries** — publish the server to the public MCP indexes once v1.0.0 is cut, so agent platforms can discover it without a manual config line. Targets: the [official MCP Registry](https://github.com/modelcontextprotocol/registry), [mcp.so](https://mcp.so), [glama.ai](https://glama.ai/mcp), [smithery.ai](https://smithery.ai).

## Compliance / governance

- **Second maintainer → OpenSSF Gold** — actively welcome co-maintainership via `.github/CODEOWNERS` once a contributor has several merged PRs. Gold requires ≥2 active maintainers; that's the gating constraint.
- **MCP SDK majors** — follow the `@modelcontextprotocol/sdk` major-version train; migrate to Zod v4-only idioms once the SDK floor allows.
