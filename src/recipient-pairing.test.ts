import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENV_PAIRED_PATH,
  ENV_RECIPIENT_PAIRING,
  addPairedAddress,
  getPairedPath,
  isAddressPaired,
  isPairingEnabled,
  readPairedList,
  removePairedAddress,
  requirePairedRecipients,
} from "./recipient-pairing.js";

describe("recipient-pairing", () => {
  let tmpDir: string;
  const prevEnv = process.env[ENV_RECIPIENT_PAIRING];
  const prevPath = process.env[ENV_PAIRED_PATH];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gmail-mcp-pairing-test-"));
    process.env[ENV_PAIRED_PATH] = join(tmpDir, "paired.json");
    delete process.env[ENV_RECIPIENT_PAIRING];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env[ENV_RECIPIENT_PAIRING];
    else process.env[ENV_RECIPIENT_PAIRING] = prevEnv;
    if (prevPath === undefined) delete process.env[ENV_PAIRED_PATH];
    else process.env[ENV_PAIRED_PATH] = prevPath;
  });

  describe("isPairingEnabled", () => {
    it("is false by default", () => {
      expect(isPairingEnabled()).toBe(false);
    });

    it('is true only for the exact string "true"', () => {
      process.env[ENV_RECIPIENT_PAIRING] = "true";
      expect(isPairingEnabled()).toBe(true);
      process.env[ENV_RECIPIENT_PAIRING] = "yes";
      expect(isPairingEnabled()).toBe(false);
      process.env[ENV_RECIPIENT_PAIRING] = "1";
      expect(isPairingEnabled()).toBe(false);
    });
  });

  describe("getPairedPath", () => {
    it("rejects a non-absolute override", () => {
      process.env[ENV_PAIRED_PATH] = "relative/paired.json";
      expect(() => getPairedPath()).toThrow(/must be an absolute path/);
    });

    it("returns the override when absolute", () => {
      expect(getPairedPath()).toBe(join(tmpDir, "paired.json"));
    });
  });

  describe("add / remove / read", () => {
    it("treats a fresh install as an empty list", () => {
      expect(readPairedList()).toEqual([]);
    });

    it("adds an address and normalises case + whitespace", () => {
      const r = addPairedAddress("  Alice@Example.COM  ");
      expect(r).toEqual({ added: true, address: "alice@example.com" });
      expect(readPairedList()).toEqual(["alice@example.com"]);
    });

    it("returns added:false on duplicate (no write, no rewrite)", () => {
      addPairedAddress("bob@example.com");
      const second = addPairedAddress("BOB@example.com");
      expect(second).toEqual({ added: false, address: "bob@example.com" });
      expect(readPairedList()).toEqual(["bob@example.com"]);
    });

    it("rejects strings that do not look like an email", () => {
      expect(() => addPairedAddress("")).toThrow(/not a valid email/);
      expect(() => addPairedAddress("plainstring")).toThrow(/not a valid email/);
    });

    it("keeps the paired list sorted on insert", () => {
      addPairedAddress("charlie@example.com");
      addPairedAddress("alice@example.com");
      addPairedAddress("bob@example.com");
      expect(readPairedList()).toEqual([
        "alice@example.com",
        "bob@example.com",
        "charlie@example.com",
      ]);
    });

    it("removes a paired address", () => {
      addPairedAddress("alice@example.com");
      addPairedAddress("bob@example.com");
      expect(removePairedAddress("Alice@example.com")).toEqual({
        removed: true,
        address: "alice@example.com",
      });
      expect(readPairedList()).toEqual(["bob@example.com"]);
    });

    it("returns removed:false for an unknown address", () => {
      expect(removePairedAddress("ghost@example.com")).toEqual({
        removed: false,
        address: "ghost@example.com",
      });
    });

    it("writes the file at mode 0o600", () => {
      addPairedAddress("alice@example.com");
      const mode = statSync(getPairedPath()).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it("re-applies 0o600 even if the file pre-existed with a different mode", () => {
      writeFileSync(
        getPairedPath(),
        JSON.stringify({ version: 1, addresses: [], updatedAt: new Date().toISOString() }),
        { mode: 0o644 },
      );
      addPairedAddress("alice@example.com");
      const mode = statSync(getPairedPath()).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  describe("isAddressPaired", () => {
    it("matches case-insensitively and after trim", () => {
      addPairedAddress("alice@example.com");
      expect(isAddressPaired("Alice@Example.com")).toBe(true);
      expect(isAddressPaired("  alice@example.com  ")).toBe(true);
      expect(isAddressPaired("bob@example.com")).toBe(false);
    });

    it("returns false on empty input rather than matching", () => {
      addPairedAddress("alice@example.com");
      expect(isAddressPaired("")).toBe(false);
      expect(isAddressPaired("   ")).toBe(false);
    });
  });

  describe("requirePairedRecipients", () => {
    it("is a no-op when pairing is disabled (default)", () => {
      expect(() =>
        requirePairedRecipients(["stranger1@example.com", "stranger2@example.com"]),
      ).not.toThrow();
    });

    it("allows every recipient when pairing is enabled and all are paired", () => {
      addPairedAddress("alice@example.com");
      addPairedAddress("bob@example.com");
      process.env[ENV_RECIPIENT_PAIRING] = "true";
      expect(() => requirePairedRecipients(["alice@example.com", "Bob@Example.com"])).not.toThrow();
    });

    it("throws listing every un-paired address when pairing is enabled", () => {
      addPairedAddress("alice@example.com");
      process.env[ENV_RECIPIENT_PAIRING] = "true";
      expect(() =>
        requirePairedRecipients(["alice@example.com", "eve@evil.com", "mallory@evil.com"]),
      ).toThrow(/eve@evil\.com, mallory@evil\.com/);
    });

    it("tolerates an empty recipient list even when pairing is enabled", () => {
      process.env[ENV_RECIPIENT_PAIRING] = "true";
      expect(() => requirePairedRecipients([])).not.toThrow();
    });
  });

  describe("readPairedList validation", () => {
    it("throws a clear error when the file is not valid JSON", () => {
      writeFileSync(getPairedPath(), "{ not json ");
      expect(() => readPairedList()).toThrow(/not valid JSON/);
    });

    it("throws a clear error when the file has the wrong shape", () => {
      writeFileSync(getPairedPath(), JSON.stringify({ version: 2, addresses: ["a@b.com"] }));
      expect(() => readPairedList()).toThrow(/expected .* shape/);
    });

    it("is tolerant of a freshly written file (round-trip)", () => {
      addPairedAddress("alice@example.com");
      const raw = readFileSync(getPairedPath(), "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(1);
      expect(parsed.addresses).toEqual(["alice@example.com"]);
      expect(typeof parsed.updatedAt).toBe("string");
    });
  });
});
