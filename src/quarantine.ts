/**
 * Mark files written by the download tools as "downloaded from the
 * internet", the way Mail, Outlook and every browser mark a saved
 * attachment:
 *
 * - macOS: the `com.apple.quarantine` extended attribute, so Gatekeeper
 *   checks an executable, script or app bundle the first time it is
 *   opened. Documents (PDF, images…) open as usual.
 * - Windows: the Mark of the Web, a `Zone.Identifier` alternate data
 *   stream with `ZoneId=3` (Internet zone), which SmartScreen and
 *   Office's Protected View act on.
 * - Linux and others: no equivalent, nothing is written.
 *
 * Never blocking: if the mark cannot be set (non-APFS volume, FAT/exFAT
 * without alternate data streams, missing `xattr`…), the failure is
 * logged on stderr and the downloaded file stays where it is.
 *
 * On by default; `GMAIL_MCP_QUARANTINE=false` turns it off.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";

export const ENV_QUARANTINE = "GMAIL_MCP_QUARANTINE";

export function isQuarantineEnabled(): boolean {
  return process.env[ENV_QUARANTINE] !== "false";
}

/**
 * The `com.apple.quarantine` value: `flags;hex-seconds;agent;uuid`.
 * `0083` is the flag set browsers write for a download (quarantined,
 * not yet approved by the user).
 */
export function macQuarantineValue(nowMs: number, uuid: string): string {
  const seconds = Math.floor(nowMs / 1000).toString(16);
  return `0083;${seconds};gmail-mcp;${uuid.toUpperCase()}`;
}

/** Content of the Windows `Zone.Identifier` stream (Internet zone). */
export const WINDOWS_ZONE_IDENTIFIER = "[ZoneTransfer]\r\nZoneId=3\r\n";

export interface QuarantineDeps {
  platform: NodeJS.Platform;
  now: () => number;
  uuid: () => string;
  runXattr: (args: string[]) => void;
  writeStream: (streamPath: string, content: string) => void;
  log: (message: string) => void;
}

/* v8 ignore start -- the production bindings shell out to /usr/bin/xattr
   and write an NTFS stream; tests inject fakes through `deps`. */
const defaultDeps: QuarantineDeps = {
  platform: process.platform,
  now: () => Date.now(),
  uuid: () => randomUUID(),
  runXattr: (args) => {
    execFileSync("/usr/bin/xattr", args, { stdio: "ignore", timeout: 5000 });
  },
  writeStream: (streamPath, content) => {
    fs.writeFileSync(streamPath, content);
  },
  log: (message) => {
    console.error(message);
  },
};
/* v8 ignore stop */

/**
 * Mark `filePath` as downloaded. Returns true when a mark was written,
 * false when the platform has none, the feature is off, or writing it
 * failed (the failure is logged, never thrown).
 */
export function markAsDownloaded(filePath: string, deps: QuarantineDeps = defaultDeps): boolean {
  if (!isQuarantineEnabled()) return false;
  try {
    if (deps.platform === "darwin") {
      deps.runXattr([
        "-w",
        "com.apple.quarantine",
        macQuarantineValue(deps.now(), deps.uuid()),
        filePath,
      ]);
      return true;
    }
    if (deps.platform === "win32") {
      deps.writeStream(`${filePath}:Zone.Identifier`, WINDOWS_ZONE_IDENTIFIER);
      return true;
    }
    return false;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    deps.log(`[quarantine] could not mark ${filePath} as downloaded (file kept): ${msg}`);
    return false;
  }
}
