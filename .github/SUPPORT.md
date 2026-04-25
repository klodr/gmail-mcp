# 🆘 Support

`@klodr/gmail-mcp` is an open-source MCP server maintained by **@klodr** in
spare time. Use the channels below — opening an issue with the right template
gives the fastest path to a triage decision.

## 🐛 Bug reports

Open an issue using the **Bug report** template. Include:

- Package version (`npm ls -g @klodr/gmail-mcp` or the `version` line from
  `read_email` debug output).
- MCP client and version (Claude Desktop / Claude Code / Cursor / OpenClaw).
- Failing command (full tool name + arguments) and the resulting error.
- If `GMAIL_MCP_AUDIT_LOG` is enabled, attach the relevant JSONL entries
  with secrets scrubbed.

## ✨ Feature requests

Open an issue using the **Feature request** template. State the use case
first, then the proposed tool / option. Proposals are evaluated against
[`docs/ROADMAP.md`](../docs/ROADMAP.md) — items already scheduled or
explicitly out-of-scope are listed there.

## 🔒 Security issues

**Do not open a public issue.** Follow the coordinated-disclosure procedure
in [`SECURITY.md`](SECURITY.md). Critical CVEs are patched within 24 h.

## ❓ Questions

Search [closed issues](https://github.com/klodr/gmail-mcp/issues?q=is%3Aissue+is%3Aclosed)
first — most operational questions (OAuth keys path, scope mismatch, missing
attachments) are already answered. If nothing matches, open a new issue
with the **Bug report** template and label it `question`.

## ⏱️ Response expectations

| Severity | Target |
|---|---|
| Critical security CVE | 24 h |
| Bug blocking normal usage | 48 h |
| Other issue / PR | 7 days |

Best-effort SLOs from a solo maintainer doing open-source on the side.
Sponsoring (see [`FUNDING.yml`](FUNDING.yml)) helps keep the lights on.
