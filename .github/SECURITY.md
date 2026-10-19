# Security Policy

## Status

> [!NOTE]
> This repository has not yet undergone a full independent third-party security review end-to-end. The hardening layer described below has been landed incrementally (path jails with `realpath` + `O_NOFOLLOW`, CRLF sanitization on both email-assembly paths, OAuth scope filtering at startup, Zod bounds on all Gmail IDs and batch sizes, crypto MIME boundary, credentials at `0o600`, opt-in redacted JSONL audit log with counterparty-PII elision by default (`GMAIL_MCP_AUDIT_LOG` + `GMAIL_MCP_AUDIT_LOG_VERBOSE` opt-out), per-bucket daily+monthly write rate limits (send/delete/modify/drafts/labels/filters), LLM-output defense-in-depth fence (`<untrusted-tool-output>`) with control / zero-width / BiDi-override stripping on every tool response, attachment-filename neutralization before disk write, protocol-error flagging (`isError: true`) on tool failures, Sigstore + SLSA + SBOM-signed releases, fast-check fuzz suite) and is tested on every CI run. Against the two parent forks (GongRzhe/Gmail-MCP-Server and ArtyMcLabin's intermediate fork), `klodr/gmail-mcp` is already a meaningful step forward on prompt-injection and supply-chain posture. For mission-critical or high-sensitivity deployments, treat the server as carefully as any third-party MCP exposed to an LLM host: prefer a narrowly-scoped OAuth token, enable human-in-the-loop confirmation on write tools, and follow this repo's release notes for security-relevant updates.

## Security model — what this MCP provides

- **OAuth scope filtering at startup.** The tool list returned to the LLM is intersected with the scopes the user granted at `auth` time. Requesting `gmail.readonly` means `send_email`, `delete_email`, etc. are literally not registered — a prompt-injected agent cannot call what is not in the list.
- **Attachment source jail.** `send_email` / `draft_email` / `reply_all` refuse to attach any file whose realpath is not inside `GMAIL_MCP_ATTACHMENT_DIR` (default `~/GmailAttachments/`, mode `0o700`). Closes the headline prompt-injection vector: a crafted inbound email instructing the agent to attach `~/.ssh/id_rsa`, `~/.gmail-mcp/credentials.json`, `~/.claude.json`, or similar.
- **Download destination jail.** `download_email` and `download_attachment` write exclusively inside `GMAIL_MCP_DOWNLOAD_DIR` (default `~/GmailDownloads/`, mode `0o700`). The leaf is opened with `O_NOFOLLOW` — a pre-existing symlink at the destination cannot be used to escape the jail. After `mkdirSync` the resolved path is re-verified against the jail root to defeat the TOCTOU window between the pre-check and the `mkdir`.
- **Input validation (Zod).** Every tool input is validated before it reaches a Gmail client call. Bounds on `maxResults`, `batchSize`, and `messageIds` array length block resource-exhaustion prompts.
- **CRLF header injection sanitization.** Every user-supplied RFC-822 header value (`From`, `To`, `Cc`, `Bcc`, `Subject`, `In-Reply-To`, `References`) is stripped of `\r`, `\n`, `\0` before the message is assembled — applied on both the attachment-less path (`createEmailMessage`) and the attachment path (`createEmailWithNodemailer`) so the invariant is in-tree and covered by the same tests on both paths.
- **Cryptographic MIME boundary.** `crypto.randomBytes(16).toString('hex')` — not `Math.random()` — so a crafted body cannot collide with the multipart boundary and inject synthetic MIME headers.
- **Credentials at rest.** Both `~/.gmail-mcp/credentials.json` (refresh token) and `~/.gmail-mcp/gcp-oauth.keys.json` (client_id + client_secret) are written with mode `0o600` — when the OAuth keys are imported from the current directory (only the `auth` subcommand does that, never a normal start), the mode is forced to `0o600` regardless of the source file's mode. `~/.gmail-mcp/` directory is `0o700`. The jail directories (`GmailAttachments`, `GmailDownloads`) are `0o700`.
- **No silent overwrite inside the download jail.** `safeWriteFile` uses `O_CREAT | O_EXCL | O_NOFOLLOW` (not `O_TRUNC`), so a prompt-injected agent cannot clobber a user file that happens to share a name with an incoming attachment (`~/GmailDownloads/report.pdf`). On collision the filename is suffixed " (1)", " (2)", … like a browser does.
- **Recipient allowlist the model cannot extend through gmail-mcp.** With `GMAIL_MCP_RECIPIENT_PAIRING=true`, every To / Cc / Bcc of `send_email`, `reply_*`, `forward_email`, `draft_email`, `update_draft` and `send_draft` must be a paired address. The model cannot pair one through gmail-mcp: `pair_recipient add` asks the human to confirm through MCP elicitation (form; the wait defaults to 10 minutes, `GMAIL_MCP_PAIRING_CONFIRM_TIMEOUT_MS`), and a client without form elicitation gets an error naming the terminal command (`npx @klodr/gmail-mcp pair add <address>`). A hostile email cannot get the agent to approve, then write to, its own address through this server. The guarantee assumes the MCP client does not also give the model unchecked terminal or file access, which could run that command or edit `paired.json` directly.
- **Draft recipients verified before sending.** `send_draft` reads the staged draft first and refuses a To / Cc / Bcc header that does not parse as a list of addresses, so a draft's destination is always known.
- **Write caps that count messages.** Per-family daily and 30-day caps on every write tool; the batch tools count each message they touch, so a single call on 1 000 messages cannot slip under the cap.
- **No forwarding filters.** `create_filter` and the filter templates refuse `action.forward`: a forwarding rule silently redirects every future matching message. Gmail forwards only to a verified forwarding address, and registering one needs the `gmail.settings.sharing` scope, which is not in the default scopes and which no tool uses (the refusal holds even when `--scopes` grants it); such rules are created in the Gmail web interface.
- **Downloads marked as coming from the internet.** Files written by the download tools get the macOS `com.apple.quarantine` attribute or the Windows Mark of the Web, as Mail and Outlook do, so the OS checks an executable or script before it runs. Never blocking; off with `GMAIL_MCP_QUARANTINE=false`.
- **Exported HTML locked down.** The `html` file of `download_email` carries a Content-Security-Policy that blocks scripts, plugins, frames, `<base>` rewrites, form submissions and, by default, every remote fetch: images, stylesheets, fonts, media and the rest (`default-src 'none'`), tracking pixels included. A sender's `<meta http-equiv="refresh">` is neutralized, since no CSP stops that navigation.
- **OAuth flow.** The loopback callback checks a per-flow `state` and uses PKCE (S256): an authorization code intercepted on the machine cannot be redeemed without the verifier held by the `auth` process.
- **Supply-chain integrity.** Every release artifact is (or will be) signed with Sigstore, ships an SLSA in-toto attestation, and carries npm provenance. All GitHub Actions in `.github/workflows/` are pinned by full commit SHA.
- **Least-privilege CI.** `permissions:` is set per-workflow with `contents: read` at the top level; individual jobs widen only the specific scopes they need.

## What this MCP does NOT protect against

- **Compromise of the host environment.** If your shell, terminal, or MCP client is compromised, your Gmail refresh token can be stolen. This MCP cannot detect or prevent that.
- **Malicious LLM prompts (prompt injection) on write tools.** An LLM that exposes write tools to untrusted email content can be tricked into calling them. Mitigations: scope the OAuth token tightly (`gmail.readonly` + `gmail.send` instead of `gmail.modify`), require human-in-the-loop confirmation for any write tool, or use a read-only token when serving untrusted channels.
- **Prompt injection through Gmail response data.** Gmail returns user-controlled fields verbatim — subject lines, display names, message bodies, filter criteria. This MCP forwards those bytes to the LLM without additional sanitization. A counterparty who controls one of those values can embed instructions that your agent may follow. The LLM host is responsible for treating tool-result content as untrusted input.
- **Account-level Gmail security.** 2FA, account recovery, suspicious-activity detection, and Google's side of OAuth consent are Google's responsibility, not this MCP's.
- **Network-level attackers beyond what TLS provides.** This MCP relies on Node's built-in `fetch` (via `googleapis`) and the system trust store. It does not pin certificates.
- **Logging downstream of this MCP.** The MCP emits an opt-in JSONL audit trail of its own (`GMAIL_MCP_AUDIT_LOG=/abs/path.jsonl`, file mode `0o600`, counterparty PII elided by default with a `GMAIL_MCP_AUDIT_LOG_VERBOSE=true` escape hatch — see `src/audit-log.ts`). However, if your MCP client (Claude Desktop, Cursor, etc.) records tool inputs/outputs to its own log, that storage is outside this project's control.

## Reporting a vulnerability

Please open a private security advisory at https://github.com/klodr/gmail-mcp/security/advisories/new. Do not open a public issue for security findings.

Response target: **acknowledgment within 48 hours**, fix or mitigation plan within 7 days for anything rated High or Critical.

## Supported runtimes

`@klodr/gmail-mcp` supports **Node.js ≥ 24.18.1** and is tested on Node 24 and 26. Node 24 is the floor that the official MCP reference servers declare in their published packages (`engines: >=24`; maintenance LTS through 2028-04-30), while Node 22, still maintained until 2027-04-30, is no longer targeted; Node 26 is the current line (LTS from 2026-10-28) and the one used for development, the Docker image and releases. The floor is pinned to the exact patch — not just `24.x` — because 24.18.1 is the latest Node 24 security release (July 2026): older 24.x patches miss at least one advisory fix, and `engine-strict` refuses them. Earlier releases shipped with `>=22.23.1` (and before that `>=20.11`, then `>=22.11`); they remain installable but will not receive back-ported security fixes.

## Verifying releases

Every published release of `@klodr/gmail-mcp` is cryptographically signed via Sigstore (keyless, via GitHub OIDC → Fulcio → Rekor). Three independent ways to verify:

### 1. npm — npm CLI

```bash
npm view @klodr/gmail-mcp@<version> --json | jq .dist.attestations
npm install --ignore-scripts @klodr/gmail-mcp@<version>
npm audit signatures
```

### 2. GitHub Release artifact — `gh attestation`

```bash
gh release download v<version> --repo klodr/gmail-mcp --pattern 'index.js*'
gh attestation verify index.js --repo klodr/gmail-mcp
```

### 3. Sigstore bundle — `cosign`

```bash
cosign verify-blob-attestation \
  --bundle index.js.sigstore \
  --certificate-identity-regexp '^https://github\.com/klodr/gmail-mcp/' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  index.js
```

## Software Bill of Materials (SBOM)

Every GitHub Release ships two SBOMs generated from the **runtime** dependency tree (`devDependencies` pruned before `syft` walks the tree) by `anchore/sbom-action`:

- `sbom.spdx.json` — SPDX 2.3 JSON
- `sbom.cdx.json` — CycloneDX 1.6 JSON

Each SBOM carries its own Sigstore attestation binding it to the `dist/index.js` of the same release run. The attestation subject is the artifact (`dist/index.js`), not the SBOM file itself — `gh attestation verify` therefore expects the artifact path plus an explicit `--predicate-type` selecting which SBOM flavor to check:

```bash
# Download the release artifact + SBOMs first
gh release download v<version> --repo klodr/gmail-mcp \
  --pattern 'index.js' --pattern 'sbom.*.json'

# SPDX
gh attestation verify index.js --repo klodr/gmail-mcp \
  --predicate-type https://spdx.dev/Document/v2.3

# CycloneDX
gh attestation verify index.js --repo klodr/gmail-mcp \
  --predicate-type https://cyclonedx.org/bom
```

Then feed the SBOMs into `grype`, `trivy`, `dependency-track`, or any SPDX/CDX-aware scanner.

## Security best practices when using this MCP

- **Scope the OAuth token as tightly as possible.** At `auth` time, request only the scopes the agent actually needs — `gmail.readonly` for reading, `gmail.readonly + gmail.send` for drafting replies, and only add `gmail.modify` when label / trash operations are needed. The server's startup scope filter hides every tool whose scope is not granted, so an unasked `delete_email` cannot be called even by a prompt-injected agent. Broader scopes (`mail.google.com`, `https://mail.google.com/`) expose the entire surface and should be a last resort.
- **Never commit OAuth keys or credentials to version control.** `~/.gmail-mcp/gcp-oauth.keys.json` (client_id + client_secret) and `~/.gmail-mcp/credentials.json` (refresh token) are both written at mode `0o600` by the server, but keeping them inside `~/.gmail-mcp/` — not alongside project files — is what keeps them out of `git add .` and backup snapshots.
- **Require human-in-the-loop confirmation on write tools.** `send_email`, `reply_all`, `draft_email`, `delete_email`, `batch_modify_emails`, `batch_delete_emails`, and the label / filter mutations can all be triggered by a prompt-injected counterparty. Configure your MCP host (Claude Desktop, Cursor, etc.) to prompt the human before executing write tools, or use `GMAIL_MCP_DRY_RUN=true` to intercept and review payloads before they ship.
- **Enable the audit log in production.** Set `GMAIL_MCP_AUDIT_LOG=/abs/path/to/audit.jsonl` to capture a tamper-evident JSONL trail of every tool call, its redacted arguments, and its terminal state (`ok` / `error` / `rate_limited` / `dry-run` — the last surfaces when `GMAIL_MCP_DRY_RUN=true` intercepts a write). Counterparty PII (subject, body, to/cc/bcc, snippet) is elided by default; flip `GMAIL_MCP_AUDIT_LOG_VERBOSE=true` only on isolated dev machines where the log will not land in a SIEM.
- **Watch the rate-limit rejections.** The per-bucket daily+monthly caps (`send`, `delete`, `modify`, `drafts`, `labels`, `filters`, `pairing`) exist precisely to bound the blast radius of a prompt-injection-driven write loop. Tool calls rejected with `mcp_rate_limit_*_exceeded` are recorded in the audit log with `result: "rate_limited"` — a sudden spike is a strong signal of abusive prompting upstream and should be investigated.
- **Contain the attachment and download jails.** `GMAIL_MCP_ATTACHMENT_DIR` (outbound) and `GMAIL_MCP_DOWNLOAD_DIR` (inbound) default to `~/GmailAttachments/` and `~/GmailDownloads/` respectively, both `0o700`. If you run the MCP in a multi-user environment or inside a container, point both to a directory that is not the operator's home — a jail directory shared with other local processes defeats the path-traversal protection.
- **Revoke immediately on suspected token exposure.** If a refresh token may have leaked, revoke it at [https://myaccount.google.com/permissions](https://myaccount.google.com/permissions) and delete `~/.gmail-mcp/credentials.json` before re-running `auth`. The MCP does not maintain a remote revocation channel.
- **Keep this package updated.** Vulnerable versions surface via Dependabot alerts on projects that depend on `@klodr/gmail-mcp`; keep Dependabot security updates enabled on the consuming repo. The npm tarball ships with a Sigstore attestation (`npm audit signatures` verifies it), so a tampered build on the registry mirror will not pass verification.

Thanks for helping keep `@klodr/gmail-mcp` and its users safe.
