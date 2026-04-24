/**
 * Recipient pairing gate for write tools.
 *
 * Caps the blast radius of a prompt-injected `send_email` / `reply_all`
 * / `draft_email` call: when `GMAIL_MCP_RECIPIENT_PAIRING=true`, every
 * `To` / `Cc` / `Bcc` address must appear in an operator-maintained
 * allowlist (`~/.gmail-mcp/paired.json` by default, overridable via
 * `GMAIL_MCP_PAIRED_PATH`). The operator pairs addresses out-of-band
 * (via the `pair_recipient` tool or by editing the file), so a
 * hostile email asking the agent to send its inbox to
 * `attacker@evil.example` cannot reach Gmail — it is rejected before
 * the API call.
 *
 * Design notes:
 * - Addresses are stored and compared case-insensitively (email local
 *   parts are case-sensitive per RFC 5321 in theory, but every
 *   mainstream provider including Gmail folds case, so matching on
 *   lowercased values avoids `Alice@X.com` vs `alice@x.com` drift).
 * - The file is written at mode `0o600` to match the rest of
 *   `~/.gmail-mcp/`. The parent directory is created at mode `0o700`
 *   if it does not already exist.
 * - The feature is OFF by default — legacy users are not broken by
 *   the install. Turning it on requires one explicit env flag plus
 *   at least one `pair_recipient` call to avoid a "fresh install
 *   refuses every send" lockout.
 */

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export const ENV_RECIPIENT_PAIRING = "GMAIL_MCP_RECIPIENT_PAIRING";
export const ENV_PAIRED_PATH = "GMAIL_MCP_PAIRED_PATH";

export function isPairingEnabled(): boolean {
  return process.env[ENV_RECIPIENT_PAIRING] === "true";
}

export function getPairedPath(): string {
  const override = process.env[ENV_PAIRED_PATH];
  if (override && override.trim() !== "") {
    if (!path.isAbsolute(override)) {
      throw new Error(`${ENV_PAIRED_PATH} must be an absolute path; got: ${override}`);
    }
    return override;
  }
  return path.join(homedir(), ".gmail-mcp", "paired.json");
}

interface PairedFile {
  version: 1;
  addresses: string[]; // stored lowercased
  updatedAt: string; // ISO-8601
}

function isPairedFile(value: unknown): value is PairedFile {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    Array.isArray(v.addresses) &&
    v.addresses.every((a) => typeof a === "string") &&
    typeof v.updatedAt === "string"
  );
}

export function readPairedList(): string[] {
  const file = getPairedPath();
  if (!fs.existsSync(file)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(`Unable to read paired-recipients file at ${file}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Paired-recipients file at ${file} is not valid JSON: ${(err as Error).message}`,
      { cause: err },
    );
  }
  if (!isPairedFile(parsed)) {
    throw new Error(
      `Paired-recipients file at ${file} does not match the expected { version:1, addresses:string[], updatedAt:string } shape.`,
    );
  }
  return parsed.addresses;
}

function writePairedList(addresses: string[]): void {
  const file = getPairedPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const payload: PairedFile = {
    version: 1,
    addresses,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
  // fs.writeFileSync honours `mode` only on CREATE — chmod after to
  // keep the mode right on a pre-existing file too.
  fs.chmodSync(file, 0o600);
}

export function isAddressPaired(email: string): boolean {
  const needle = email.trim().toLowerCase();
  if (!needle) return false;
  return readPairedList().includes(needle);
}

export function addPairedAddress(email: string): { added: boolean; address: string } {
  const normalised = email.trim().toLowerCase();
  if (!normalised || !normalised.includes("@")) {
    throw new Error(`"${email}" is not a valid email address.`);
  }
  const current = readPairedList();
  if (current.includes(normalised)) {
    return { added: false, address: normalised };
  }
  writePairedList([...current, normalised].sort());
  return { added: true, address: normalised };
}

export function removePairedAddress(email: string): { removed: boolean; address: string } {
  const normalised = email.trim().toLowerCase();
  const current = readPairedList();
  const next = current.filter((a) => a !== normalised);
  if (next.length === current.length) {
    return { removed: false, address: normalised };
  }
  writePairedList(next);
  return { removed: true, address: normalised };
}

/**
 * Throw if any of `recipients` is not in the paired allowlist AND the
 * feature is enabled. When the feature is disabled (default), this is
 * a no-op — the existing send/reply/draft path is preserved verbatim.
 *
 * Error message lists every un-paired address so the operator (or the
 * human in a human-in-the-loop flow) sees exactly which ones to pair.
 */
export function requirePairedRecipients(recipients: readonly string[]): void {
  if (!isPairingEnabled()) return;
  if (recipients.length === 0) return;
  const paired = new Set(readPairedList());
  const rejected: string[] = [];
  for (const r of recipients) {
    const normalised = r.trim().toLowerCase();
    if (!normalised) continue;
    if (!paired.has(normalised)) rejected.push(r.trim());
  }
  if (rejected.length === 0) return;
  const plural = rejected.length === 1 ? "address is" : "addresses are";
  throw new Error(
    `Recipient pairing gate: ${rejected.length} ${plural} not in the paired allowlist at ${getPairedPath()} — ${rejected.join(", ")}. ` +
      `Pair each address via the \`pair_recipient\` tool, or unset ${ENV_RECIPIENT_PAIRING} to disable the gate.`,
  );
}
