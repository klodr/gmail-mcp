# Roadmap

Loose planning horizon of ~12 months, ordered by intent (not a commitment):

## Near-term (next release cycle)

- **Complete code audit** — this fork inherits code from two upstream chains (GongRzhe → ArtyMcLabin) and still carries patterns, dead branches, and duplicated helpers from both. A single pass through every file in `src/`, with the security-hardening posture as the baseline, to remove what is not used, consolidate what is duplicated, and document what remains non-obvious. Not a rewrite — a cleanup. Blocks v1.0.0.
- **Test coverage on `src/index.ts`** — the single `CallToolRequestSchema` dispatcher + its 25 tool cases + the OAuth callback path are currently 0% covered (the file is untouched by tests; global statement coverage sits at ~39% because everything else is ≥ 93%). Raising this requires either a refactor that pulls each tool-case body into a directly-callable helper (preferred) or a mocked-googleapis integration pass (heavier). Target: global statement coverage ≥ 70% before v1.0.0, ideally ≥ 85%.
- **Re-tighten Codecov thresholds — deadline 2026-05-15** — `codecov.yml` was temporarily relaxed (`project.target: 35%` / `patch.target: 75%`) when the vitest coverage scope was corrected to include every `src/**/*.ts` (previously v8 silently omitted un-imported files, inflating the apparent global to ~93%). The loosened gate is a bridge. Once the handler-extraction refactor lands and global coverage climbs back to ≥ 80%, bump `project.target` back to `auto` with `threshold: 0.5%`, and `patch.target` back to `95%` with `threshold: 1.5%`. Hard deadline so the relaxed config doesn't drift into permanent tolerance.
- **v1.0.0 on npm** — cut the first tagged release of `@klodr/gmail-mcp` once the audit lands on `main`; every release is signed with Sigstore (keyless GitHub OIDC), ships an SLSA in-toto attestation, and carries npm provenance.
- **Recipient pairing gate** — add a `pair_recipient` tool and a `~/.gmail-mcp/paired.json` allowlist so `send_email` / `reply_all` / `draft_email` refuse to email an address the human has never approved, capping the blast radius of a prompt-injected `send_email` call.
- **Migrate `Server` (legacy) → `McpServer` (ergonomic SDK API)** — the server is instantiated via the low-level `new Server(..., { capabilities: { tools: {} } })` pattern inherited from the GongRzhe → ArtyMcLabin fork chain. `CallToolRequestSchema` dispatches through a 1300-line switch over 25 tool cases, capabilities are declared by hand, and Zod → JSON Schema conversion is explicit. The modern `McpServer` API (already used by mercury-invoicing-mcp and faxdrop-mcp) replaces all of that with `server.registerTool(name, { description, inputSchema }, handler)` and `server.registerPrompt(...)` — capabilities auto-declared, dispatch/validation handled by the SDK, shorter error surface. The migration folds naturally into the **Complete code audit** item above: extract each tool-case into its own handler module (→ testable directly, unblocks the 70%+ coverage target), then register them against an `McpServer`. Hold until those two items are scheduled together.
- **Graceful `invalid_grant` handling** — when Google rejects the refresh token (user revoked consent, the OAuth app was disabled, the token was reissued elsewhere), every tool currently fails with a raw `invalid_grant` from `google-auth-library` that propagates as a generic MCP error. Catch that specific failure at the client layer and surface a single structured response pointing the agent / operator at a concrete recovery step: `"Re-run \`npx @klodr/gmail-mcp auth\` — the refresh token at ~/.gmail-mcp/credentials.json is no longer honoured by Google (likely revoked or expired after 6 months of inactivity)."` Also emit a log line on startup if the stored token fails the `/oauth2/v2/userinfo` smoke test, so the failure shows up once rather than on the first real tool call.

## Gmail API surface not yet wrapped

The MCP currently covers ~25 tools across messages, threads, labels, and filters. Planned additions as demand emerges:

- **Drafts CRUD** — `drafts.list`, `drafts.get`, `drafts.update`, `drafts.delete`, `drafts.send` (only `drafts.create` is wired today via `draft_email`).
- **Send-as aliases** — `settings.sendAs.*` (create / update / delete / verify) for managing Gmail aliases programmatically.
- **Vacation responder** — `settings.vacation` get/update for enabling/disabling the auto-responder.
- **Forwarding addresses** — `settings.forwardingAddresses.*`.
- **POP / IMAP settings** — `settings.pop`, `settings.imap`.
- **Push notifications** — `users.watch` + `users.history.list` for near-real-time inbox event streaming.

## Discoverability

- **MCP registries** — publish the server to the public MCP indexes once v1.0.0 is cut, so agent platforms can discover it without a manual config line. Targets: the [official MCP Registry](https://github.com/modelcontextprotocol/registry), [mcp.so](https://mcp.so), [glama.ai](https://glama.ai/mcp), [smithery.ai](https://smithery.ai).

## Compliance / governance

- **Second maintainer → OpenSSF Gold** — actively welcome co-maintainership via `.github/CODEOWNERS` once a contributor has several merged PRs. Gold requires ≥2 active maintainers; that's the gating constraint.
- **MCP SDK majors** — follow the `@modelcontextprotocol/sdk` major-version train; migrate to Zod v4-only idioms once the SDK floor allows.

