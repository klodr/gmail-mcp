/**
 * Vitest setup file (`setupFiles` in vitest.config.ts): runs before
 * every test file, in the worker that runs it.
 *
 * Gives each test file its own temporary directory and points every
 * gmail-mcp state override at it, so no test can write to the real
 * `~/.gmail-mcp/` (rate-limit counter, paired recipients, OAuth files),
 * `~/GmailDownloads/` or `~/GmailAttachments/` of whoever runs the
 * suite. Before this file existed, the handler tests that call write
 * tools without their own `GMAIL_MCP_STATE_DIR` added ~20 sends to the
 * developer's real `~/.gmail-mcp/ratelimit.json` on every `npm test`.
 *
 * - On load, the overrides are set unconditionally: a value inherited
 *   from the developer's shell may point at the real state.
 * - Before each test, an override a previous test deleted is set again;
 *   a value a test file set itself (in `beforeAll`, at module scope or
 *   in its own `beforeEach`, which runs after this one) is kept. Tests
 *   that already create their own scratch directory keep working.
 * - `GMAIL_MCP_AUDIT_LOG` is opt-in and has no default: an inherited
 *   value is removed, tests that need it set it themselves.
 * - After each test, any write the guard in `src/state-guard.ts`
 *   refused fails that test, even if the code path swallowed the error.
 *   A refusal recorded outside a test (module scope, `beforeAll`) fails
 *   the next test; one recorded in an `afterAll` fails the file.
 * - After the file, its temporary directory is removed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach } from "vitest";
import { takeRefusedDefaultStateWrites } from "../src/state-guard.js";

const scratch = mkdtempSync(join(tmpdir(), "gmail-mcp-test-state-"));

const ISOLATED_STATE_ENV: Readonly<Record<string, string>> = Object.freeze({
  GMAIL_MCP_STATE_DIR: join(scratch, "state"),
  GMAIL_MCP_PAIRED_PATH: join(scratch, "state", "paired.json"),
  GMAIL_OAUTH_PATH: join(scratch, "state", "gcp-oauth.keys.json"),
  GMAIL_CREDENTIALS_PATH: join(scratch, "state", "credentials.json"),
  GMAIL_MCP_DOWNLOAD_DIR: join(scratch, "downloads"),
  GMAIL_MCP_ATTACHMENT_DIR: join(scratch, "attachments"),
});

const CLEARED_ENV = ["GMAIL_MCP_AUDIT_LOG"] as const;

for (const [key, value] of Object.entries(ISOLATED_STATE_ENV)) process.env[key] = value;
for (const key of CLEARED_ENV) delete process.env[key];

function failOnRefusedWrites(where: string): void {
  const refused = takeRefusedDefaultStateWrites();
  if (refused.length > 0) {
    throw new Error(
      `${where} tried to write to the user's default gmail-mcp state:\n- ${refused.join("\n- ")}`,
    );
  }
}

beforeEach(() => {
  // A refusal recorded outside any test (module scope, `beforeAll`)
  // fails the first test instead of going unnoticed.
  failOnRefusedWrites("Code run before this test (module scope or beforeAll)");
  for (const [key, value] of Object.entries(ISOLATED_STATE_ENV)) {
    if (!process.env[key]) process.env[key] = value;
  }
});

afterEach(() => {
  failOnRefusedWrites("This test");
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  failOnRefusedWrites("An afterAll hook of this file");
});
