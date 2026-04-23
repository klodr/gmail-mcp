# Roadmap

Loose planning horizon of ~12 months, ordered by intent (not a commitment).

## Near-term (next release cycle)

- **Complete code audit** — this fork inherits code from two upstream chains (GongRzhe → ArtyMcLabin) and still carries patterns, dead branches, and duplicated helpers from both. A single pass through every file in `src/`, with the security-hardening posture as the baseline, to remove what is not used, consolidate what is duplicated, and document what remains non-obvious. Not a rewrite — a cleanup. Blocks v1.0.0.
- **Test coverage on `src/index.ts`** — the single `CallToolRequestSchema` dispatcher + its 25 tool cases + the OAuth callback path are currently 0% covered (the file is untouched by tests; global statement coverage sits at ~39% because everything else is ≥ 93%). Raising this requires either a refactor that pulls each tool-case body into a directly-callable helper (preferred) or a mocked-googleapis integration pass (heavier). Target: global statement coverage ≥ 70% before v1.0.0, ideally ≥ 85%.
- **Re-tighten Codecov thresholds — deadline 2026-05-15** — `codecov.yml` was temporarily relaxed (`project.target: 35%` / `patch.target: 75%`) when the vitest coverage scope was corrected to include every `src/**/*.ts` (previously v8 silently omitted un-imported files, inflating the apparent global to ~93%). The loosened gate is a bridge. Once the handler-extraction refactor lands and global coverage climbs back to ≥ 80%, bump `project.target` back to `auto` with `threshold: 0.5%`, and `patch.target` back to `95%` with `threshold: 1.5%`. Hard deadline so the relaxed config doesn't drift into permanent tolerance.
- **v1.0.0 on npm** — cut the first tagged release of `@klodr/gmail-mcp` once the audit and the parity + ergonomics items below land on `main`; every release is signed with Sigstore (keyless GitHub OIDC), ships an SLSA in-toto attestation, and carries npm provenance.
- **Recipient pairing gate** — add a `pair_recipient` tool and a `~/.gmail-mcp/paired.json` allowlist so `send_email` / `reply_all` / `draft_email` refuse to email an address the human has never approved, capping the blast radius of a prompt-injected `send_email` call.
- **Migrate `Server` (legacy) → `McpServer` (ergonomic SDK API)** — the server is instantiated via the low-level `new Server(..., { capabilities: { tools: {} } })` pattern inherited from the GongRzhe → ArtyMcLabin fork chain. `CallToolRequestSchema` dispatches through a 1300-line switch over 25 tool cases, capabilities are declared by hand, and Zod → JSON Schema conversion is explicit. The modern `McpServer` API (already used by mercury-invoicing-mcp and faxdrop-mcp) replaces all of that with `server.registerTool(name, { description, inputSchema }, handler)` and `server.registerPrompt(...)` — capabilities auto-declared, dispatch/validation handled by the SDK, shorter error surface. The migration folds naturally into the **Complete code audit** item above: extract each tool-case into its own handler module (→ testable directly, unblocks the 70%+ coverage target), then register them against an `McpServer`. Hold until those two items are scheduled together.
- **Graceful `invalid_grant` handling** — when Google rejects the refresh token (user revoked consent, the OAuth app was disabled, the token was reissued elsewhere), every tool currently fails with a raw `invalid_grant` from `google-auth-library` that propagates as a generic MCP error. Catch that specific failure at the client layer and surface a stable structured payload so clients / agents can branch on `code` rather than parsing free text. Contract:

  ```json
  {
    "code": "INVALID_GRANT",
    "message": "The Gmail refresh token was rejected by Google. It was likely revoked by the user, expired after 6 months of inactivity, or reissued elsewhere.",
    "recovery_action": "Re-run `npx @klodr/gmail-mcp auth` to reauthorise.",
    "credential_path": "~/.gmail-mcp/credentials.json"
  }
  ```

  Client guidance: branch on `code === "INVALID_GRANT"`, render `message` in any human-facing surface, surface `recovery_action` as the next-step CTA (copy-pasteable command), and include `credential_path` only when the operator needs to know which file to delete or relocate. Also emit a single log line on startup if the stored token fails the `/oauth2/v2/userinfo` smoke test, so the failure shows up once at boot rather than on the first real tool call.

## v0.10.0 — Parity release

Bring `klodr/gmail-mcp` up to the hardening baseline already shipped in the sibling MCP servers [mercury-invoicing-mcp](https://github.com/klodr/mercury-invoicing-mcp) and [faxdrop-mcp](https://github.com/klodr/faxdrop-mcp). These items land as a group because they share a prerequisite (middleware extraction) and together constitute the hardening floor the other two repos already enforce.

- **Extract `src/middleware.ts`** — the rate-limit and audit-log wiring currently lives inline inside the `CallToolRequestSchema` switch in `src/index.ts`. Extract a `wrapToolHandler(name, handler)` middleware, mirroring `mercury-invoicing-mcp/src/middleware.ts:359` and `faxdrop-mcp/src/middleware.ts:203`. This is the prerequisite that unlocks dry-run, structuredContent, timeouts, and sanitizeForLlm without duplicating glue code in 25 switch cases.
- **`GMAIL_MCP_DRY_RUN` environment flag** — when set, every write tool (`send_email`, `reply_all`, `draft_email`, `delete_email`, `batch_modify_emails`, `batch_delete_emails`, `modify_email`, `create_label`, `update_label`, `delete_label`, `create_filter`, `delete_filter`) short-circuits before calling Gmail and returns the payload it would have sent, with sensitive fields redacted. Matches `MERCURY_MCP_DRY_RUN` (mercury middleware.ts:255) and `FAXDROP_MCP_DRY_RUN` (faxdrop middleware.ts:25). Useful for CI smoke tests, agent debugging, and human-in-the-loop approval flows.
- **`sanitizeForLlm` fence** — wrap all attacker-influenced fields returned to the LLM (message body, subject, snippet, sender display name, thread participant names, attachment filenames) in `<untrusted-tool-output>…</untrusted-tool-output>` fences after stripping C0 control characters. Same helper already shipped at `faxdrop-mcp/src/sanitize.ts` and `mercury-invoicing-mcp/src/sanitize.ts`. Gmail is the highest-exposure surface in the three: any email can carry a prompt-injection payload in its subject or body and today we relay it unfenced.
- **`AbortSignal.timeout` on every Gmail API call** — wrap every `gmail.users.*` call with a 30-second timeout (matching mercury `client.ts:72`). Without it, a slow Gmail response hangs the entire MCP stdio session and there is no way for the client to recover without killing the process.
- **`structuredContent` in `ToolResult`** — the MCP 2025-06-18 specification requires `structuredContent` for programmatic consumers. Current gmail-mcp emits zero `structuredContent` fields; faxdrop emits it in 13 places; mercury emits it throughout. Add it alongside the existing text content block so MCP clients that introspect the structured payload (registries, test harnesses) see the shape of each response.
- **Audit log elision-by-length** — keep the existing blocklist strategy on credentials (`token`, `password`, `authorization`) but add per-field length elision on free-form string payloads (`body`, `subject`, `snippet`) so the JSONL audit trail carries a `[…245 chars]` marker rather than the full attacker-controlled text. Hybrid of mercury's blocklist and faxdrop's `redactForAudit` elision pattern (faxdrop middleware.ts:96+), adapted to gmail's wider field surface.
- **`scripts/prod-readonly-test.mjs`** — a pre-release smoke-test that runs a gmail.readonly token against `list_email_labels`, `search_emails q:in:inbox`, and a handful of message reads, and fails the release if anything crashes. Matches the `prod-readonly-test.mjs` that already ships in `mercury-invoicing-mcp/scripts/`. The parallel `sandbox-test.mjs` from mercury does not apply here — Gmail, like FaxDrop, has no vendor-provided sandbox environment.
- **`SECURITY.md` expansion** — pull in the sections present in mercury's and faxdrop's SECURITY.md that are absent from ours: SBOM disclosure line, response-time targets for vulnerability reports, explicit scope boundaries, and "Security best practices when using this MCP" covering token scoping, host-side filesystem containment, and audit-log consumption.

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
