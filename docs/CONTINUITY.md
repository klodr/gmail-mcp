# Project continuity plan

`@klodr/gmail-mcp` is maintained by a single individual (`@klodr`).
This document explains how the project can continue with minimal
interruption (≤1 week) if I become unavailable.

## Built-in resilience (FLOSS guarantees)

- **Source code**: public on GitHub under [MIT](./LICENSE). Anyone can fork
  and continue development.
- **Release artifacts**: every published version is signed with Sigstore
  (`dist/index.js.sigstore`) and ships an SLSA in-toto attestation
  (`dist/index.js.intoto.jsonl`), plus npm provenance. Downstream users
  can verify the chain of custody of any past release even if the
  original repo or npm scope becomes unmaintained.
- **Build & release pipeline** is fully automated in
  [`.github/workflows/release.yml`](./.github/workflows/release.yml) and
  documented in [`CHANGELOG.md`](./CHANGELOG.md). A fork can reproduce
  releases by configuring `NPM_TOKEN` and pushing a tag.
- **No proprietary infrastructure**: all third-party integrations
  (CodeQL, Scorecard, Socket Security, Codecov, Dependabot,
  CodeRabbit) are free and re-attachable to a fork.
- **User-side state is local**: every user's OAuth refresh token lives
  on their own machine at `~/.gmail-mcp/credentials.json` (mode `0o600`).
  No server-side state exists that could be stranded by a
  maintainer handover.

## Within 1 week of confirmed unavailability

If the maintainer is confirmed unable to continue, anyone can:

1. Fork [`klodr/gmail-mcp`](https://github.com/klodr/gmail-mcp).
2. Continue issue triage, PR review, and merges in the fork.
3. Publish releases under their own npm scope (e.g.
   `@yourname/gmail-mcp`) following the documented release flow —
   this typically takes minutes once `NPM_TOKEN` is set.
4. Update downstream MCP client configs to point at the fork's package.

### Takeover checklist for the first release

- [ ] Run the full test suite locally: `npm ci && npm test` — must pass on Node 22 and 24
- [ ] Run `npm run build` and confirm the build succeeds with no warnings
- [ ] Bump the version (`npm version patch`) and add a `## [Unreleased]` → `## [X.Y.Z]` entry to `CHANGELOG.md`
- [ ] Tag with a signed tag: `git tag -s vX.Y.Z -m "..." && git push origin vX.Y.Z`
- [ ] Confirm the `Release & npm publish` workflow ran green and uploaded **all three** assets to the GitHub Release: `dist/index.js`, `dist/index.js.sigstore`, `dist/index.js.intoto.jsonl`
- [ ] Verify npm provenance: `npm view <fork-package>@<version> dist.attestations` returns a non-empty array
- [ ] Verify the Sigstore signature using the procedure in [SECURITY.md → Verifying releases](../.github/SECURITY.md#verifying-releases-once-v1-is-out)
- [ ] Update README badges and `CONTINUITY.md` references to point at the fork

There is no organisational lock-in: every secret and every external
service can be re-provisioned by the new maintainer, typically within
hours, depending on third-party account approval and token issuance times.

End users keep full control of their own OAuth credentials; a fork
can consume an existing `~/.gmail-mcp/credentials.json` without
requiring re-authorisation as long as the `client_id` in
`~/.gmail-mcp/gcp-oauth.keys.json` is preserved.

## Ongoing improvements

- Adding a second maintainer is welcomed. Contributors with multiple
  merged PRs may propose adding their handle to
  [`.github/CODEOWNERS`](./.github/CODEOWNERS).
- The maintainer's contact is on the
  [GitHub profile](https://github.com/klodr) for emergency hand-off
  coordination.
