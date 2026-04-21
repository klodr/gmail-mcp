# Roadmap

Loose planning horizon of ~12 months, ordered by intent (not a commitment):

## Near-term (next release cycle)

- **Complete code audit** — this fork inherits code from two upstream chains (GongRzhe → ArtyMcLabin) and still carries patterns, dead branches, and duplicated helpers from both. A single pass through every file in `src/`, with the security-hardening posture as the baseline, to remove what is not used, consolidate what is duplicated, and document what remains non-obvious. Not a rewrite — a cleanup. Blocks v1.0.0.
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

