# Roadmap

Loose planning horizon of ~12 months, ordered by intent (not a commitment):

## Near-term (next release cycle)

- **Node.js 22 migration — deadline 2026-04-30** — Node 20 reaches security-support EOL on April 30, 2026. Bump `engines.node` to `>=22.0.0`, retarget `tsup.config.ts` to `node22`, pin the Dockerfile to `node:22-alpine@sha256:…`, drop Node 20 from the CI matrix (keep 22/24), bump `@types/node` to `^22.x`. Roughly 10 surfaces to touch; not bundled in the security-audit PR because of its breadth. Blocking for any release cut after 2026-04-30.
- **Complete code audit** — this fork inherits code from two upstream chains (GongRzhe → ArtyMcLabin) and still carries patterns, dead branches, and duplicated helpers from both. A single pass through every file in `src/`, with the security-hardening posture as the baseline, to remove what is not used, consolidate what is duplicated, and document what remains non-obvious. Not a rewrite — a cleanup. Blocks v1.0.0.
- **Test coverage on `src/index.ts`** — the single `CallToolRequestSchema` dispatcher + its 25 tool cases + the OAuth callback path are currently 0% covered (the file is untouched by tests; global statement coverage sits at ~39% because everything else is ≥ 93%). Raising this requires either a refactor that pulls each tool-case body into a directly-callable helper (preferred) or a mocked-googleapis integration pass (heavier). Target: global statement coverage ≥ 70% before v1.0.0, ideally ≥ 85%.
- **Re-tighten Codecov thresholds — deadline 2026-05-15** — `codecov.yml` was temporarily relaxed (`project.target: 35%` / `patch.target: 75%`) when the vitest coverage scope was corrected to include every `src/**/*.ts` (previously v8 silently omitted un-imported files, inflating the apparent global to ~93%). The loosened gate is a bridge. Once the handler-extraction refactor lands and global coverage climbs back to ≥ 80%, bump `project.target` back to `auto` with `threshold: 0.5%`, and `patch.target` back to `95%` with `threshold: 1.5%`. Hard deadline so the relaxed config doesn't drift into permanent tolerance.
- **v1.0.0 on npm** — cut the first tagged release of `@klodr/gmail-mcp` once the audit lands on `main`; every release is signed with Sigstore (keyless GitHub OIDC), ships an SLSA in-toto attestation, and carries npm provenance.
- **Recipient pairing gate** — add a `pair_recipient` tool and a `~/.gmail-mcp/paired.json` allowlist so `send_email` / `reply_all` / `draft_email` refuse to email an address the human has never approved, capping the blast radius of a prompt-injected `send_email` call.
- **Optional audit log** — `GMAIL_MCP_AUDIT_LOG=/abs/path` for a redacted JSONL trail (mode `0o600`) of every tool call, with sensitive fields (OAuth tokens, message bodies, attachment bytes) stripped before write.

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

