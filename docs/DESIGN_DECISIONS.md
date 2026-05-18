# Design Decisions

Architectural and naming decisions for klodr/gmail-mcp. Each entry
records a choice that diverges from a naive implementation, an
upstream behaviour, or a vendor pattern — and the rationale.

## Positioning

The upstream — [ArtyMcLabin/Gmail-MCP-Server](https://github.com/ArtyMcLabin/Gmail-MCP-Server) —
describes itself as "lean and pragmatic" and names this fork the
**maximalist** one. That label is accurate from the outside (we ship
more code, more tests, more CI/CD than upstream) but it misframes the
intent. klodr/gmail-mcp is not heavy for the sake of being heavy.
The product is built around four properties — **secure**,
**autonomous**, **tested**, **resilient under acceleration** — and
every kilogram of code or workflow that does not pay rent on one of
those four is a candidate for removal.

### Secure

The defence is in the server, not in the operator's attention span.
Middleware components (`audit-log.ts`, `rate-limit.ts`, `sanitize.ts`,
`recipient-pairing.ts`, `sender-resolver.ts`, `gmail-errors.ts`,
`middleware.ts`) constrain what an autonomous client can do at runtime:
they sanitize input the LLM provides, rate-limit the Gmail API call
volume, audit every action, and refuse to send mail to unpaired
recipients. The Gmail surface is not exposed raw to whatever the LLM
guesses; it is mediated.

### Autonomous

The server is designed to run **without a human watching every action
the LLM takes**. The same server that is safe in supervised use stays
safe when the supervisor is asleep. That is a different threat model
from upstream's "I use it daily in my own Claude Code workflow" —
upstream assumes a human is online; klodr assumes the human may not be.
The middleware is what bridges that gap.

### Tested

Test coverage is 1.58× the source code (≈12.8 kLOC of tests for
≈8.1 kLOC of source). Tests are not just on the happy path; they
exercise the middleware, the OAuth flow, the rate-limiter, the
mime walkers, the sanitize boundaries, and the failure modes of every
batch operation. A change can pass typecheck and still get blocked by
a behavioural regression captured in test fixtures.

### Resilient under acceleration

The CI/CD pile (17 workflows, SHA-pinned actions, OSV / Gitleaks /
leak-detect / CodeQL / Scorecard, signed commits, audited supply
chain, lockfile lint, npm `--ignore-scripts`, attest-build-provenance,
verify-release SLSA) is not paranoia — it is **how the project
absorbs the speed at which the ecosystem changes**. When a
transitive npm dependency ships a CVE, the lockfile-lint + OSV
scanner pair surfaces it, release-please opens the bump PR, the
review pipeline gates it, the package is republished. Recent
concrete instance: **qs CVE-2026-8723**, surfaced and shipped within
hours of the public advisory across the klodr/* MCP family.

Tool names and descriptions follow the same rule. An autonomous LLM
reading them must not be misled. If a tool's name suggests a
capability the server does not actually deliver, the design decisions
file records why and the tool is renamed or omitted (see DD-001).

### The trade

The cost is real — more code, more workflows, more drift surface,
more pinned-SHA bookkeeping. The benefit is that the operator does
not need to be in the loop on a per-action basis, and the project
keeps tracking the security ecosystem at the pace it actually
changes (days, sometimes hours), not at the pace of a side-project
trickle. That trade is the product.

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
is sender-side aggregate, and the Apps Script thread-level helpers
`GmailThread.moveToSpam()` / `GmailApp.moveThreadToSpam(thread)` /
`GmailApp.moveThreadsToSpam(threads)` which move threads to the Spam
folder but do not expose any additional anti-phishing feedback channel
beyond what the v1 API call already does). Third-party "Report
phishing" add-ons (Expel, CanIPhish, Proofpoint, Material Security)
all route reports to an external SOC; none of them push back into
Google's classifier.

Even Gmail's own documentation describes the manual spam-folder move
as a **spam** training signal, not a phishing-specific one (see Gmail
Help — [Mark or unmark Spam in Gmail](https://support.google.com/mail/answer/1366858)).

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
- [Mark or unmark Spam in Gmail (Gmail Help)](https://support.google.com/mail/answer/1366858)
- [Admin SDK Alert Center — MailPhishing](https://developers.google.com/admin-sdk/alertcenter/reference/rest/v1beta1/MailPhishing)
- [Apps Script — `GmailApp.moveThreadToSpam`](https://developers.google.com/apps-script/reference/gmail/gmail-app#moveThreadToSpam(GmailThread))
- [Sublime Security — Gmail's Report Phishing feature](https://docs.sublime.security/docs/gmails-report-phishing-feature)
- Upstream commit: `ArtyMcLabin/Gmail-MCP-Server@007b816d`

---
