# Design Decisions

Architectural and naming decisions for klodr/gmail-mcp. Each entry
records a choice that diverges from a naive implementation, an
upstream behaviour, or a vendor pattern — and the rationale.

## Positioning

klodr/gmail-mcp is the **maximalist** of the Gmail-MCP fork family.
The upstream — [ArtyMcLabin/Gmail-MCP-Server](https://github.com/ArtyMcLabin/Gmail-MCP-Server) —
describes itself as "lean and pragmatic" and explicitly points at
this fork for users who want the heavier posture. The two products
share an ancestor, no longer share a roadmap.

What that posture means in practice:

- The server is meant to run **without a human watching every action
  the LLM takes**. The middleware (`audit-log.ts`, `rate-limit.ts`,
  `sanitize.ts`, `recipient-pairing.ts`, `sender-resolver.ts`,
  `gmail-errors.ts`, `middleware.ts`) is there so an autonomous LLM
  client can use the surface without a human acting as the runtime
  validator. The defence is in the server, not in the operator's
  attention span.
- The CI/CD pile (17 workflows, SHA-pinned actions, OSV/Gitleaks/
  leak-detect/CodeQL/Scorecard, signed commits, audited supply chain)
  is the same idea applied to development: a non-human contributor
  (= an LLM doing the bulk of the commits) is constrained by the
  pipeline rather than by a human reading every diff line.
- Tool names and descriptions follow the same rule: an autonomous LLM
  reading them must not be misled. If a tool's name suggests a
  capability the server does not actually deliver, the design
  decisions file records why and the tool is renamed or omitted
  (see DD-001).

The cost of this posture is well understood — more code, more
workflows, more drift surface, more pinned-SHA bookkeeping. The
benefit is that the operator does not need to be in the loop on a
per-action basis. That trade is the product.

---

## DD-001 — No `report_phishing` tool; use `move_to_spam` instead

**Date**: 2026-05-18
**Status**: accepted

### Context

The upstream fork (`ArtyMcLabin/Gmail-MCP-Server`) added a
`report_phishing` MCP tool (commit `007b816d`, PR by ShivamB25) that
applies the `SPAM` system label via `users.messages.modify`. The tool
is named after Gmail's UI "Report phishing" menu item.

### Problem

The UI "Report phishing" button does **two distinct things**:

1. Applies the `SPAM` label (moves the message to the Spam folder).
2. Sends an explicit user-feedback signal into Google's ML
   anti-phishing classifier.

The Gmail API only exposes step 1. Step 2 is **not reachable from any
public endpoint** (verified across the v1 Gmail API, the Admin SDK
Alert Center API which is read-only, the Postmaster Tools API which
is sender-side aggregate, and the Apps Script `GmailApp.moveToSpam`
which Google itself documents as "closest to" — i.e. not equivalent
to — clicking the UI button). Third-party "Report phishing" add-ons
(Expel, CanIPhish, Proofpoint, Material Security) all route reports
to an external SOC; none of them push back into Google's classifier.

Even Gmail's own documentation describes the manual spam-folder move
as a **spam** training signal, not a phishing-specific one.

A tool named `report_phishing` whose implementation is exactly
`addLabelIds: ["SPAM"]` therefore promises a feedback effect it
cannot deliver. An autonomous LLM acting on this tool's name (no
human in the loop) would believe it is contributing to anti-phishing
detection when in practice it is only spam-foldering the message.

### Decision

1. Do **not** ship a `report_phishing` tool.
2. Ship a `move_to_spam` / `move_to_spam_batch` tool instead. Same
   underlying API call (`users.messages.modify` with
   `addLabelIds: ["SPAM"]`), honest name, honest description.
3. Tool description must explicitly state: applies the `SPAM` label
   only — closest public-API approximation of an automatic
   "Report spam" action — and does **not** trigger Google's ML
   phishing-feedback signal (UI-only).

### Consequences

- LLM clients are not misled by a tool name that overpromises.
- Users who actually need to feed Google's phishing classifier
  continue to do so via the Gmail UI button (this is documented in
  the tool description so an LLM can suggest the manual step when
  appropriate).
- Surface is slightly narrower than the upstream fork — acceptable
  given the upstream itself documents the limitation in its own
  tool response text.

### References

- [Gmail API users.messages.modify](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify)
- [Avoid & report phishing emails (Gmail Help)](https://support.google.com/mail/answer/8253?hl=en)
- [Admin SDK Alert Center — MailPhishing](https://developers.google.com/admin-sdk/alertcenter/reference/rest/v1beta1/MailPhishing)
- [Sublime Security — Gmail's Report Phishing feature](https://docs.sublime.security/docs/gmails-report-phishing-feature)
- Upstream commit: `ArtyMcLabin/Gmail-MCP-Server@007b816d`

---
