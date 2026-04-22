# Security Policy

## Status

> [!WARNING]
> This repository has **not yet** been independently security-reviewed end-to-end. The hardening layer described below is being rolled out through a series of PRs (see the `feat/security-hardening` branch and `feat(security):` commit history). Use at your own risk until the audit lands.

## Security model — what this MCP provides

- **OAuth scope filtering at startup.** The tool list returned to the LLM is intersected with the scopes the user granted at `auth` time. Requesting `gmail.readonly` means `send_email`, `delete_email`, etc. are literally not registered — a prompt-injected agent cannot call what is not in the list.
- **Attachment source jail.** `send_email` / `draft_email` / `reply_all` refuse to attach any file whose realpath is not inside `GMAIL_MCP_ATTACHMENT_DIR` (default `~/GmailAttachments/`, mode `0o700`). Closes the headline prompt-injection vector: a crafted inbound email instructing the agent to attach `~/.ssh/id_rsa`, `~/.gmail-mcp/credentials.json`, `~/.claude.json`, or similar.
- **Download destination jail.** `download_email` and `download_attachment` write exclusively inside `GMAIL_MCP_DOWNLOAD_DIR` (default `~/GmailDownloads/`, mode `0o700`). The leaf is opened with `O_NOFOLLOW` — a pre-existing symlink at the destination cannot be used to escape the jail. After `mkdirSync` the resolved path is re-verified against the jail root to defeat the TOCTOU window between the pre-check and the `mkdir`.
- **Input validation (Zod).** Every tool input is validated before it reaches a Gmail client call. Bounds on `maxResults`, `batchSize`, and `messageIds` array length block resource-exhaustion prompts.
- **CRLF header injection sanitization.** Every user-supplied RFC-822 header value (`From`, `To`, `Cc`, `Bcc`, `Subject`, `In-Reply-To`, `References`) is stripped of `\r`, `\n`, `\0` before the message is assembled.
- **Cryptographic MIME boundary.** `crypto.randomBytes(16).toString('hex')` — not `Math.random()` — so a crafted body cannot collide with the multipart boundary and inject synthetic MIME headers.
- **Credentials at rest.** `~/.gmail-mcp/credentials.json` is written with mode `0o600`. `~/.gmail-mcp/` directory is `0o700`. The jail directories (`GmailAttachments`, `GmailDownloads`) are `0o700`.
- **Supply-chain integrity.** Every release artifact is (or will be) signed with Sigstore, ships an SLSA in-toto attestation, and carries npm provenance. All GitHub Actions in `.github/workflows/` are pinned by full commit SHA.
- **Least-privilege CI.** `permissions:` is set per-workflow with `contents: read` at the top level; individual jobs widen only the specific scopes they need.

## What this MCP does NOT protect against

- **Compromise of the host environment.** If your shell, terminal, or MCP client is compromised, your Gmail refresh token can be stolen. This MCP cannot detect or prevent that.
- **Malicious LLM prompts (prompt injection) on write tools.** An LLM that exposes write tools to untrusted email content can be tricked into calling them. Mitigations: scope the OAuth token tightly (`gmail.readonly` + `gmail.send` instead of `gmail.modify`), require human-in-the-loop confirmation for any write tool, or use a read-only token when serving untrusted channels.
- **Prompt injection through Gmail response data.** Gmail returns user-controlled fields verbatim — subject lines, display names, message bodies, filter criteria. This MCP forwards those bytes to the LLM without additional sanitization. A counterparty who controls one of those values can embed instructions that your agent may follow. The LLM host is responsible for treating tool-result content as untrusted input.
- **Account-level Gmail security.** 2FA, account recovery, suspicious-activity detection, and Google's side of OAuth consent are Google's responsibility, not this MCP's.
- **Network-level attackers beyond what TLS provides.** This MCP relies on Node's built-in `fetch` (via `googleapis`) and the system trust store. It does not pin certificates.
- **Logging downstream of this MCP.** The MCP emits no audit log of its own (yet — tracked as a follow-up). If your MCP client (Claude Desktop, Cursor, etc.) records tool inputs/outputs to its own log, that is outside this project's control.

## Reporting a vulnerability

Please open a private security advisory at https://github.com/klodr/gmail-mcp/security/advisories/new. Do not open a public issue for security findings.

Response target: **acknowledgment within 48 hours**, fix or mitigation plan within 7 days for anything rated High or Critical.

## Verifying releases (once v1 is out)

Every published release of `@klodr/gmail-mcp` will be cryptographically signed via Sigstore (keyless, via GitHub OIDC → Fulcio → Rekor). Three independent ways to verify:

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
