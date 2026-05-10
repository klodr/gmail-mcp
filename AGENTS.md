# AGENTS.md

This repository is **gmail-mcp** — a Model Context Protocol server that
exposes the Gmail v1 API to AI assistants behind scope-gated tools
(~33 tools across messages, threads, labels, filters, drafts,
downloads, batch ops). It is a hardened + enhanced fork of
[GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server)
(archived) via
[ArtyMcLabin/Gmail-MCP-Server](https://github.com/ArtyMcLabin/Gmail-MCP-Server),
with 130+ commits of divergence — prompt-injection guards, OAuth
scope-gating, batch retry, supply-chain hygiene, and CI gating.

This file is the **canonical source of truth** for any AI agent that
edits the code in this repository. Read it before making changes. It
encodes the conventions the maintainers actually enforce — not
aspirations.

> If you are an installation agent (i.e. helping a user **install** the
> MCP server in their client config rather than **edit** the server
> code), stop reading this file and read `llms-install.md` instead.
> That file is for the install audience; this one is for code-editing
> agents.

## Audience boundary

| Audience                                           | Source of truth                                |
| -------------------------------------------------- | ---------------------------------------------- |
| Edits this repo's code                             | **`AGENTS.md`** (you are here)                 |
| Installs this MCP into a client config             | `llms-install.md`                              |
| Threat model / security argument                   | `docs/ASSURANCE_CASE.md`                       |
| Disaster recovery / continuity                     | `docs/CONTINUITY.md`                           |
| Forward-looking work                               | `docs/ROADMAP.md`                              |
| Comparison vs upstream forks                       | `docs/COMPETITORS.md`                          |
| End-user features and install commands             | `README.md`                                    |
| Vulnerability reporting                            | `.github/SECURITY.md`                          |

Do not duplicate what those documents say. Reference them.

## Setup

Node `>=22.22.2` is **enforced** via `engines` + `engine-strict=true` in
`.npmrc`. CI runs the matrix on Node 22 and 24. `npm install` on Node
21 fails immediately — that is intentional.

```bash
npm install
```

This repo uses **npm**, not pnpm. Lockfile is `package-lock.json`.

Husky hooks install via the `prepare` script. The package is published
as `@klodr/gmail-mcp` (scoped, public).

## Build, test, lint, typecheck

The exact npm scripts (see `package.json`):

| Command                     | What it does                              |
| --------------------------- | ----------------------------------------- |
| `npm run typecheck`         | `tsc --noEmit`                            |
| `npm run build`             | `typecheck` then `tsup` bundle to `dist/` |
| `npm run start`             | `node dist/index.js` (stdio MCP server)   |
| `npm run auth`              | OAuth flow (writes credentials file 0o600)|
| `npm run test`              | `vitest run` (also emits JUnit XML)       |
| `npm run test:watch`        | `vitest`                                  |
| `npm run test:coverage`     | `vitest run --coverage`                   |
| `npm run lint`              | ESLint on `src/`                          |
| `npm run format`            | Prettier write on entire tree             |
| `npm run format:check`      | Prettier check (CI gate)                  |

Run `npm run lint && npm run typecheck && npm test` before every push.
Husky's `pre-push` will do it for you, but failing locally before push
is faster than failing in CI.

## Code style

- TypeScript strict (`strictTypeChecked` preset of `typescript-eslint`).
- ESM (`"type": "module"`); use `.js` import specifiers in `src/`.
- ESLint flat config in `eslint.config.js`. Type-aware rules — must
  resolve via `parserOptions.projectService: true`.
- Prettier (no override file → defaults).
- `eqeqeq: error` (always strict equality).
- `no-console: warn` — only `console.error` / `console.warn` allowed.
- `import-x/no-unresolved: off` — TS / vitest already validate imports;
  the rule cannot follow `./*` exports maps from the MCP SDK.
- Tests are excluded from lint (`src/**/*.test.ts` in the ignore
  list). Lint and tests are independent gates.

## Tests

- Framework: **vitest** with the default reporter.
- Test files co-located in `src/` next to the unit they cover
  (e.g. `src/threads-handlers.test.ts` next to logic split into
  `src/tools/threads.ts` + helpers). Pattern: `**/*.test.ts`.
- Coverage provider: `v8`. Reporters: `text`, `lcov`, `json`. The
  JSON report carries per-branch hit counts so Codecov can compute
  accurate indirect-changes — do not remove it.
- Coverage `include` deliberately covers `src/**/*.ts` AND
  `scripts/**/*.mjs` so untested files appear at 0% rather than being
  silently omitted.
- `src/index.ts` is excluded from coverage (stdio CLI shim — testing
  it requires booting `StdioServerTransport`, which deadlocks the
  test runner). The orchestration it wraps lives in `runtime.ts` and
  is covered there. `scripts/prod-readonly-test.mjs` is also
  excluded (real-token smoke test, not a unit test).
- Use `InMemoryTransport` from `@modelcontextprotocol/sdk` for
  end-to-end handler tests. Existing tests under `src/` are the
  reference pattern.

## Commits

- **Conventional commits** (`feat:`, `fix:`, `docs:`, `chore:`,
  `refactor:`, `test:`, `ci:`, `build:`).
- **Signed commits required.** Pre-push hook verifies via `%G?` and
  rejects anything other than `G`/`U`/`E`. Configure SSH commit
  signing or set `commit.gpgsign=true`.
- **Subject ≤72 characters.** Pre-push counts unicode code points
  (not bytes) so emoji and accented characters count correctly.
- **No `Co-Authored-By:` trailers.** This repo's maintainers do not
  use co-authorship attribution on AI-assisted commits.

## Pre-push gate (`.husky/pre-push`)

For every new commit being pushed:

1. Signature is `G`/`U`/`E`.
2. Subject ≤72 chars (unicode-aware).

Then once per push:

1. `npm run format:check`
2. `npm run lint`
3. `npm run typecheck`
4. `npm run test`
5. `npm audit --audit-level=high`

Bypass with `git push --no-verify` only when the hook itself is wrong
(rare). The bypass is recorded in the local reflog.

## PR workflow

- Open the PR against `main`.
- Wait for CodeRabbit review (assertive profile) and dual-model Qodo
  Merge (DeepSeek + Gemini). Drain every comment thread before
  re-pinging — never spam `@coderabbitai review` while threads are
  unresolved.
- CodeRabbit commands are posted **bare**, no surrounding prose
  (e.g. a comment whose entire body is `@coderabbitai review`).
- Do not let CodeRabbit push commits — this repo is solo-maintained
  and a bot commit would block merge under branch protection.
- Auto-merge: `gh pr merge --squash --auto`. Branch protection waits
  on CI + CodeRabbit + Scorecard.
- Maintainers do not self-approve their own PRs. Approvals only
  from external bots (release-please-app, dependabot).

## Source layout (highlights)

```text
src/
  index.ts              stdio entry point (excluded from coverage)
  server.ts             MCP server wiring
  runtime.ts            orchestration (covered in lieu of index.ts)
  oauth-flow.ts         OAuth 2.0 with PKCE + offline access
  scopes.ts             granted-scope resolver + tool gating
  tools/
    _shared.ts          shared registrar helpers
    drafts.ts           draft CRUD
    messages.ts         message read/list/delete + batch
    messaging.ts        send / reply / reply-all
    threads.ts          thread-level read + list_inbox_threads
    labels.ts           label CRUD
    filters.ts          filter CRUD + create_filter_from_template
    downloads.ts        download_email + download_attachment
    output-schemas.ts   JSON schemas for tool outputs
    index.ts            registrar entry point
  middleware.ts         audit log + dry-run
  rate-limit.ts         in-process token bucket
  recipient-pairing.ts  thread participant resolver for reply-all
  reply-all-helpers.ts  pure helpers for reply-all addressing
  sender-resolver.ts    send-as alias resolution
  filter-manager.ts     filter creation helpers
  label-manager.ts      label creation helpers
  email-send.ts         RFC 5322 message builder
  email-export.ts       json/eml/txt/html serialisation
  mime-walkers.ts       MIME tree walkers (attachments, body)
  gmail-headers.ts      header normalisation (Message-ID, References)
  gmail-errors.ts       error mapping (Gmail 4xx/5xx → MCP isError)
  audit-log.ts          JSONL audit log (mode 0o600)
  sanitize.ts           audit-log redaction
  hardening.ts          OS-level hardening (unset env, fd close, …)
  utl.ts                tiny utilities (validate-email, etc.)
  prompts.ts            prompt templates
docs/
  ASSURANCE_CASE.md     security argument (threat model + mitigations)
  COMPETITORS.md        comparison vs upstream forks
  CONTINUITY.md         disaster recovery / continuity plan
  ROADMAP.md            forward-looking work
```

## Security guards encoded in the code

The security posture is described in full in `docs/ASSURANCE_CASE.md`.
What follows is the minimum an editor must know to avoid regressing it:

- **Scope gating**: tools are filtered by the OAuth scopes actually
  granted (`scopes.ts`). A read-only token never sees `send_email`
  in the tool list. Adding a new tool → declare its required scopes
  in the registrar; do not bypass the gate.
- **OAuth credentials file mode `0o600`**: enforced in `oauth-flow.ts`
  on write. Do not relax.
- **Audit-log redaction**: `sanitize.ts` uses an explicit allowlist
  for fields kept in clear, blocks credential fields, elides
  everything else with a length marker. Adding a new tool that takes
  free-form input → extend the test, not the allowlist.
- **Reply threading**: `gmail-headers.ts` + `reply-all-helpers.ts`
  produce the `In-Reply-To` / `References` headers the upstream fork
  was missing. Do not orphan replies.
- **Recipient pairing** for reply-all: `recipient-pairing.ts`
  deduplicates the user's own addresses (including send-as aliases)
  out of the recipient set. Bug here = sending to oneself.
- **Batch ops**: `batch.ts` retries with exponential backoff on
  Gmail's 429 / 5xx; the retry budget is bounded.

## Before opening a PR — checklist

1. `npm run format && npm run lint && npm run typecheck && npm test`
2. New behaviour has a test. New error path has a test. New tool has
   a scope declaration in the registrar.
3. Commit subject ≤72 chars, signed, conventional, no Co-Authored-By.
4. If you touched a security guard listed above: also re-read the
   matching section in `docs/ASSURANCE_CASE.md` and update it if the
   threat model shifted.
5. If you changed user-facing behaviour: update `README.md` and the
   relevant section of `llms-install.md`. If you changed the
   capability matrix vs upstream, also update `docs/COMPETITORS.md`.
