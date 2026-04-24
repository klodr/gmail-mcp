## Summary

<!-- 1-3 bullets describing what this PR changes and WHY. Link the
     issue / CodeRabbit finding / ROADMAP entry if applicable. -->

## Type

<!-- Check all that apply. -->

- [ ] `feat` — new user-facing feature or tool
- [ ] `fix` — bug fix
- [ ] `docs` — documentation only
- [ ] `refactor` — no behaviour change
- [ ] `perf` — performance
- [ ] `test` — test-only change
- [ ] `ci` — CI / workflows / release plumbing
- [ ] `chore` — deps, build, or other repo-management
- [ ] `security` — security-sensitive change (see Security checklist below)

## Checklist

- [ ] `npm test` green locally (vitest)
- [ ] `npm run build` succeeds (includes `tsc --noEmit`)
- [ ] `npm run lint` clean
- [ ] `npm run format:check` clean
- [ ] `CHANGELOG.md` updated under `[Unreleased]` (if user-visible)
- [ ] Conventional-commit PR title ≤72 chars

## Security checklist (only if you ticked `security` above)

- [ ] Threat model in `ASSURANCE_CASE.md` still accurate after this change — or has been updated
- [ ] New file-system writes routed through `resolveDownloadSavePath()` or `assertAttachmentPathAllowed()` (`src/utl.ts`)
- [ ] New user-supplied RFC-822 header values passed through `sanitizeHeaderValue()`
- [ ] New Zod input schema has `.max()` bounds on any unbounded field
- [ ] Tool registered in `src/tools.ts` with correct `scopes` + `readOnlyHint` / `destructiveHint` / `idempotentHint`

## Notes for reviewers

<!-- Anything non-obvious about the implementation, edge cases deliberately
     not covered, or follow-up work that belongs in a separate PR. -->
