/**
 * Test-only guard against writes to the developer's real local state.
 *
 * The rate limiter, the paired-recipient allowlist, the OAuth files and
 * the download / attachment jails all fall back to locations under the
 * user's home directory when their env override is unset:
 *   - `~/.gmail-mcp/` (ratelimit.json, paired.json, gcp-oauth.keys.json,
 *     credentials.json)
 *   - `~/GmailDownloads/` (download jail)
 *   - `~/GmailAttachments/` (attachment jail)
 *
 * A test that exercises one of those writers without pointing the
 * matching env var at a temporary directory writes to the REAL state of
 * whoever runs `npm test`. That is how the suite used to add ~20 sends
 * to `~/.gmail-mcp/ratelimit.json` on every run, until the developer's
 * own server refused to send ("Daily Limit Exceeded") while Gmail showed
 * a handful of real sends.
 *
 * `test/isolate-state.setup.ts` points every override at a per-file
 * temporary directory. This guard is the second layer: under vitest
 * (`process.env.VITEST` is set in every vitest worker), a write that
 * still resolves inside one of the default locations above throws an
 * explicit error, and the refusal is recorded so the setup file fails
 * the test even when the code path swallows the error (the audit log,
 * the MCP SDK turning a thrown handler error into `isError: true`).
 *
 * Outside vitest the guard returns immediately: no production
 * behaviour change.
 */

import os from "node:os";
import path from "node:path";

/** Default state locations, relative to a home directory. */
const DEFAULT_STATE_ROOTS: readonly string[] = [".gmail-mcp", "GmailDownloads", "GmailAttachments"];

const REFUSED_WRITES_KEY = Symbol.for("@klodr/gmail-mcp/refused-default-state-writes");

/**
 * Refusals recorded since the last `takeRefusedDefaultStateWrites()`.
 * Kept on `globalThis` (not in module scope) so a test that calls
 * `vi.resetModules()` and re-imports this module still reports into
 * the list the setup file reads.
 */
function refusedWrites(): string[] {
  const store = globalThis as typeof globalThis & { [REFUSED_WRITES_KEY]?: string[] };
  store[REFUSED_WRITES_KEY] ??= [];
  return store[REFUSED_WRITES_KEY];
}

export class DefaultStateWriteError extends Error {
  constructor(
    public readonly target: string,
    public readonly envVariable: string,
  ) {
    super(
      `Refusing to write ${target} under vitest: it is a default gmail-mcp state ` +
        `location in the user's home (~/.gmail-mcp, ~/GmailDownloads, ~/GmailAttachments). ` +
        `Point ${envVariable} at a temporary directory ` +
        `(test/isolate-state.setup.ts does it for every test file).`,
    );
    this.name = "DefaultStateWriteError";
  }
}

/**
 * Every home directory a default location can resolve under: `$HOME`
 * (what `os.homedir()` returns) and the account's passwd entry, which
 * does not follow `$HOME` — a test that points `HOME` at a scratch
 * directory still cannot reach the real one.
 */
function homeDirectories(): string[] {
  const homes = new Set<string>([path.resolve(os.homedir())]);
  try {
    homes.add(path.resolve(os.userInfo().homedir));
  } catch {
    // No passwd entry for the uid (some containers): `$HOME` only.
  }
  return [...homes];
}

function isInside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  if (relative === "") return true;
  /* v8 ignore next -- Windows only: across drives, path.relative
     returns an absolute path (the target is outside the root). */
  if (path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

/**
 * Under vitest, throw `DefaultStateWriteError` (and record it) when
 * `target` is one of the default state locations or sits inside one.
 * `envVariable` names the override the test should have set; it goes
 * into the error message. No-op outside vitest.
 */
export function assertNotDefaultStateUnderTest(target: string, envVariable: string): void {
  if (!process.env.VITEST) return;
  const resolved = path.resolve(target);
  for (const home of homeDirectories()) {
    for (const root of DEFAULT_STATE_ROOTS) {
      if (isInside(resolved, path.join(home, root))) {
        const error = new DefaultStateWriteError(resolved, envVariable);
        refusedWrites().push(error.message);
        throw error;
      }
    }
  }
}

/**
 * Return the refusals recorded since the previous call and clear the
 * list. Read by `test/isolate-state.setup.ts` after every test.
 */
export function takeRefusedDefaultStateWrites(): string[] {
  const list = refusedWrites();
  return list.splice(0);
}
