/**
 * `gmail-mcp pair add|remove|list` — the terminal door to the paired
 * recipients, used to approve an address when the MCP client cannot ask
 * the human to confirm.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPairCommand, runServer } from "../src/runtime.js";
import { readPairedList } from "../src/recipient-pairing.js";

// Built at runtime so no literal address sits in the diff (leak-detect).
const mail = (user: string): string => `${user}@example.com`;

let dir: string;
let logs: string[];
let codes: number[];
const log = (msg: string, ...rest: unknown[]): void => {
  logs.push([msg, ...rest].join(" "));
};
const exit = (code: number): void => {
  codes.push(code);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gmail-mcp-pair-cli-"));
  process.env.GMAIL_MCP_PAIRED_PATH = join(dir, "paired.json");
  delete process.env.GMAIL_MCP_RECIPIENT_PAIRING;
  logs = [];
  codes = [];
});

afterEach(() => {
  delete process.env.GMAIL_MCP_PAIRED_PATH;
  delete process.env.GMAIL_MCP_RECIPIENT_PAIRING;
  rmSync(dir, { recursive: true, force: true });
});

describe("runPairCommand", () => {
  it("adds, lists and removes an address", () => {
    runPairCommand(["add", `Partner <${mail("Partner")}>`], log, exit);
    expect(logs.at(-1)).toBe(`Paired "${mail("partner")}".`);
    runPairCommand(["add", mail("partner")], log, exit);
    expect(logs.at(-1)).toBe(`"${mail("partner")}" was already paired.`);
    expect(readPairedList()).toEqual([mail("partner")]);

    process.env.GMAIL_MCP_RECIPIENT_PAIRING = "true";
    runPairCommand(["list"], log, exit);
    expect(logs).toContain(`  - ${mail("partner")}`);
    expect(logs.join("\n")).not.toContain("is not enforced");

    runPairCommand(["remove", mail("partner")], log, exit);
    expect(logs.at(-1)).toBe(`Unpaired "${mail("partner")}".`);
    runPairCommand(["remove", mail("partner")], log, exit);
    expect(logs.at(-1)).toBe(`"${mail("partner")}" was not paired.`);
    expect(codes.every((c) => c === 0)).toBe(true);
  });

  it("warns that the list is not enforced while the gate is off", () => {
    runPairCommand(["list"], log, exit);
    expect(logs[0]).toContain("Paired recipients (0)");
    expect(logs.join("\n")).toContain('GMAIL_MCP_RECIPIENT_PAIRING is not "true"');
    expect(codes).toEqual([0]);
  });

  it.each([[[]], [["add"]], [["remove"]], [["purge", mail("x")]]])(
    "prints the usage and exits 1 for %j",
    (args) => {
      runPairCommand(args, log, exit);
      expect(logs.at(-1)).toContain("Usage: gmail-mcp pair add <address>");
      expect(codes).toEqual([1]);
    },
  );

  it("reports an invalid address and exits 1", () => {
    runPairCommand(["add", "not an address"], log, exit);
    expect(logs.at(-1)).toContain("pair add:");
    expect(logs.at(-1)).toContain("not a valid email address");
    expect(codes).toEqual([1]);
  });
});

describe("runServer pair", () => {
  it("handles `pair` before loading any OAuth keys", async () => {
    await runServer({
      argv: ["node", "index.js", "pair", "add", mail("cli")],
      // Paths that do not exist: `pair` must not need them.
      env: {
        GMAIL_OAUTH_PATH: join(dir, "missing-keys.json"),
        GMAIL_CREDENTIALS_PATH: join(dir, "missing-credentials.json"),
      },
      log,
      exit,
    });
    expect(readPairedList()).toEqual([mail("cli")]);
    expect(codes).toEqual([0]);
    expect(logs.join("\n")).not.toContain("OAuth");
  });
});
