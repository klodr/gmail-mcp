# Contributing

PRs welcome. Please open an issue first for substantial changes (new tool, breaking behavior change, or anything touching the OAuth flow).

## Before submitting a PR

1. `npm install` then `npm test` (all tests must stay green)
2. `npm run build` (must succeed — the published tarball is a single-file `dist/index.js` produced by `tsup`)
3. `npm run lint` (must be clean)
4. `npm run format:check` (or run `npm run format` to reformat)
5. Update `CHANGELOG.md` under `[Unreleased]`
6. If you add or rename a tool, update the `Tools` section in the README and the entry in `src/tools.ts` (`toolDefinitions` array) — including the correct `scopes` and the `readOnlyHint` / `destructiveHint` / `idempotentHint` annotations
7. New file-path inputs must be routed through `resolveDownloadSavePath()` or `assertAttachmentPathAllowed()` (no raw `fs.writeFileSync(userPath, …)` — see `src/utl.ts` for the canonical jail helpers)

## Developer Certificate of Origin

Every commit must carry a `Signed-off-by:` trailer to certify compliance with [DCO 1.1](https://developercertificate.org/). The trailer is added automatically by `git commit -s` or our prepare-commit-msg hook.

## CodeRabbit review policy

Every PR must pass CodeRabbit's assertive review and obtain a formal `APPROVED` review state before merge (see `.coderabbit.yaml`). `@coderabbitai approve` is allowed only via the built-in auto-review flow; do not click "Commit suggestion" on inline diffs — CodeRabbit-authored commits deadlock branch protection on a solo-maintainer repo.

## Releases (maintainers only)

Release process is not yet automated on this repo (tracked — will match the `klodr/faxdrop-mcp` / `klodr/mercury-invoicing-mcp` pattern once the upstream npm package name transition is resolved).
