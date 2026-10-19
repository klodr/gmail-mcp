import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ENV_QUARANTINE,
  isQuarantineEnabled,
  macQuarantineValue,
  markAsDownloaded,
  WINDOWS_ZONE_IDENTIFIER,
  type QuarantineDeps,
} from "../src/quarantine.js";

const UUID = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
const NOW = 1_760_000_000_000; // ms

function fakeDeps(platform: NodeJS.Platform, failWith?: Error) {
  const calls = {
    xattr: [] as string[][],
    streams: [] as [string, string][],
    logs: [] as string[],
  };
  const deps: QuarantineDeps = {
    platform,
    now: () => NOW,
    uuid: () => UUID,
    runXattr: (args) => {
      if (failWith) throw failWith;
      calls.xattr.push(args);
    },
    writeStream: (streamPath, content) => {
      if (failWith) throw failWith;
      calls.streams.push([streamPath, content]);
    },
    log: (message) => {
      calls.logs.push(message);
    },
  };
  return { deps, calls };
}

// Independent of the caller's environment: a GMAIL_MCP_QUARANTINE set
// before the run must not change what these tests expect.
let savedQuarantine: string | undefined;
beforeEach(() => {
  savedQuarantine = process.env[ENV_QUARANTINE];
  delete process.env[ENV_QUARANTINE];
});
afterEach(() => {
  if (savedQuarantine === undefined) delete process.env[ENV_QUARANTINE];
  else process.env[ENV_QUARANTINE] = savedQuarantine;
});

describe("macQuarantineValue", () => {
  it("uses the browser download flags, hex seconds, the agent name and an upper-case UUID", () => {
    expect(macQuarantineValue(NOW, UUID)).toBe(
      `0083;${Math.floor(NOW / 1000).toString(16)};gmail-mcp;${UUID.toUpperCase()}`,
    );
  });
});

describe("markAsDownloaded", () => {
  it("sets com.apple.quarantine on macOS", () => {
    const { deps, calls } = fakeDeps("darwin");
    expect(markAsDownloaded("/jail/invoice.pdf", deps)).toBe(true);
    expect(calls.xattr).toEqual([
      ["-w", "com.apple.quarantine", macQuarantineValue(NOW, UUID), "/jail/invoice.pdf"],
    ]);
  });

  it("writes the Mark of the Web stream on Windows", () => {
    const { deps, calls } = fakeDeps("win32");
    expect(markAsDownloaded("C:\\jail\\invoice.pdf", deps)).toBe(true);
    expect(calls.streams).toEqual([
      ["C:\\jail\\invoice.pdf:Zone.Identifier", WINDOWS_ZONE_IDENTIFIER],
    ]);
    expect(WINDOWS_ZONE_IDENTIFIER).toContain("ZoneId=3");
  });

  it("writes nothing on Linux", () => {
    const { deps, calls } = fakeDeps("linux");
    expect(markAsDownloaded("/jail/invoice.pdf", deps)).toBe(false);
    expect(calls.xattr).toEqual([]);
    expect(calls.streams).toEqual([]);
  });

  it("does nothing when GMAIL_MCP_QUARANTINE=false", () => {
    process.env[ENV_QUARANTINE] = "false";
    expect(isQuarantineEnabled()).toBe(false);
    const { deps, calls } = fakeDeps("darwin");
    expect(markAsDownloaded("/jail/invoice.pdf", deps)).toBe(false);
    expect(calls.xattr).toEqual([]);
  });

  it("is on by default", () => {
    expect(isQuarantineEnabled()).toBe(true);
  });

  it.each(["darwin", "win32"] as const)(
    "never blocks on %s: a failure is logged and reported, not thrown",
    (platform) => {
      const { deps, calls } = fakeDeps(platform, new Error("operation not supported"));
      expect(markAsDownloaded("/jail/invoice.pdf", deps)).toBe(false);
      expect(calls.logs[0]).toContain("could not mark /jail/invoice.pdf");
      expect(calls.logs[0]).toContain("operation not supported");
    },
  );

  it("reports a non-Error throw too", () => {
    const deps: QuarantineDeps = {
      ...fakeDeps("darwin").deps,
      runXattr: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "raw failure";
      },
    };
    const logs: string[] = [];
    deps.log = (m) => logs.push(m);
    expect(markAsDownloaded("/jail/a.pdf", deps)).toBe(false);
    expect(logs[0]).toContain("raw failure");
  });
});
