import { describe, it, expect } from "vitest";
import {
  SCOPE_MAP,
  SCOPE_REVERSE_MAP,
  DEFAULT_SCOPES,
  scopeNameToUrl,
  scopeUrlToName,
  scopeNamesToUrls,
  hasScope,
  parseScopes,
  validateScopes,
  getAvailableScopeNames,
} from "./scopes.js";

describe("SCOPE_MAP / SCOPE_REVERSE_MAP invariants", () => {
  it("reverse map is bijective with forward map", () => {
    for (const [short, full] of Object.entries(SCOPE_MAP)) {
      expect(SCOPE_REVERSE_MAP[full]).toBe(short);
    }
    // Same cardinality — no duplicate keys or values.
    expect(Object.keys(SCOPE_REVERSE_MAP).length).toBe(Object.keys(SCOPE_MAP).length);
  });

  it("every URL uses an https Google scope origin", () => {
    // The vast majority sit under https://www.googleapis.com/auth/. The
    // single exception is the legacy mail.google.com scope, which Google
    // exposes as the bare https://mail.google.com/ URL — it's the only
    // scope that authorizes permanent delete (users.messages.delete).
    for (const [name, url] of Object.entries(SCOPE_MAP)) {
      if (name === "mail.google.com") {
        expect(url).toBe("https://mail.google.com/");
      } else {
        expect(url.startsWith("https://www.googleapis.com/auth/")).toBe(true);
      }
    }
  });

  it("DEFAULT_SCOPES are all valid shorthand names", () => {
    for (const scope of DEFAULT_SCOPES) {
      expect(SCOPE_MAP[scope]).toBeDefined();
    }
  });

  it("mail.google.com resolves to the legacy bare URL (only scope authorizing permanent delete)", () => {
    expect(SCOPE_MAP["mail.google.com"]).toBe("https://mail.google.com/");
    expect(scopeNameToUrl("mail.google.com")).toBe("https://mail.google.com/");
    expect(scopeUrlToName("https://mail.google.com/")).toBe("mail.google.com");
  });
});

describe("scopeNameToUrl / scopeUrlToName", () => {
  it("translates a known shorthand to its full URL", () => {
    expect(scopeNameToUrl("gmail.readonly")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(scopeNameToUrl("gmail.settings.basic")).toBe(
      "https://www.googleapis.com/auth/gmail.settings.basic",
    );
  });

  it("passes an unknown input through unchanged (for full URLs already)", () => {
    const full = "https://www.googleapis.com/auth/gmail.modify";
    expect(scopeNameToUrl(full)).toBe(full);
    expect(scopeNameToUrl("not-a-scope")).toBe("not-a-scope");
  });

  it("translates a known URL back to its shorthand", () => {
    expect(scopeUrlToName("https://www.googleapis.com/auth/gmail.send")).toBe("gmail.send");
  });

  it("passes an unknown URL through unchanged", () => {
    expect(scopeUrlToName("https://example.com/foo")).toBe("https://example.com/foo");
    expect(scopeUrlToName("gmail.readonly")).toBe("gmail.readonly");
  });

  it("name ↔ url roundtrip for every mapped scope", () => {
    for (const short of Object.keys(SCOPE_MAP)) {
      expect(scopeUrlToName(scopeNameToUrl(short))).toBe(short);
    }
  });
});

describe("scopeNamesToUrls", () => {
  it("maps an array of names to URLs preserving order", () => {
    expect(scopeNamesToUrls(["gmail.readonly", "gmail.send"])).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
    ]);
  });

  it("returns an empty array for an empty input", () => {
    expect(scopeNamesToUrls([])).toEqual([]);
  });

  it("passes unknown entries through (no silent drop)", () => {
    expect(scopeNamesToUrls(["gmail.readonly", "unknown.scope"])).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
      "unknown.scope",
    ]);
  });
});

describe("hasScope", () => {
  it("accepts a matching shorthand scope", () => {
    expect(hasScope(["gmail.readonly"], ["gmail.readonly"])).toBe(true);
  });

  it("accepts a matching full URL on the authorized side", () => {
    expect(hasScope(["https://www.googleapis.com/auth/gmail.send"], ["gmail.send"])).toBe(true);
  });

  it("returns true if ANY required scope is granted (OR semantics)", () => {
    expect(hasScope(["gmail.readonly"], ["gmail.modify", "gmail.readonly"])).toBe(true);
  });

  it("returns false when no required scope is present", () => {
    expect(hasScope(["gmail.readonly"], ["gmail.send"])).toBe(false);
  });

  it("handles mixed URL/shorthand on both sides", () => {
    expect(
      hasScope(
        ["https://www.googleapis.com/auth/gmail.modify", "gmail.settings.basic"],
        ["gmail.modify"],
      ),
    ).toBe(true);
  });

  it("returns false on empty authorized list", () => {
    expect(hasScope([], ["gmail.readonly"])).toBe(false);
  });

  it("returns false on empty required list (nothing to grant)", () => {
    expect(hasScope(["gmail.modify"], [])).toBe(false);
  });
});

describe("parseScopes", () => {
  it("splits on commas", () => {
    expect(parseScopes("gmail.readonly,gmail.send")).toEqual(["gmail.readonly", "gmail.send"]);
  });

  it("splits on whitespace (spaces and tabs)", () => {
    expect(parseScopes("gmail.readonly gmail.send\tgmail.labels")).toEqual([
      "gmail.readonly",
      "gmail.send",
      "gmail.labels",
    ]);
  });

  it("splits on mixed commas and whitespace", () => {
    expect(parseScopes("gmail.readonly, gmail.send ,  gmail.labels")).toEqual([
      "gmail.readonly",
      "gmail.send",
      "gmail.labels",
    ]);
  });

  it("drops empty entries (trailing comma / double comma)", () => {
    expect(parseScopes("gmail.readonly,,gmail.send,")).toEqual(["gmail.readonly", "gmail.send"]);
  });

  it("returns an empty array for empty/whitespace-only input", () => {
    expect(parseScopes("")).toEqual([]);
    expect(parseScopes("   ")).toEqual([]);
    expect(parseScopes(",,,")).toEqual([]);
  });
});

describe("validateScopes", () => {
  it("accepts a list of known shorthand scopes", () => {
    const { valid, invalid } = validateScopes(["gmail.readonly", "gmail.send"]);
    expect(valid).toBe(true);
    expect(invalid).toEqual([]);
  });

  it("reports the invalid entries without aborting", () => {
    const { valid, invalid } = validateScopes(["gmail.readonly", "gmail.wat", "typo.scope"]);
    expect(valid).toBe(false);
    expect(invalid).toEqual(["gmail.wat", "typo.scope"]);
  });

  it("rejects full URLs (validates the shorthand, not the URL form)", () => {
    // validateScopes is meant to run on the user's CLI input which is
    // always shorthand. Full URLs must go through scopeUrlToName first.
    const { valid } = validateScopes(["https://www.googleapis.com/auth/gmail.readonly"]);
    expect(valid).toBe(false);
  });

  it("accepts empty input as trivially valid", () => {
    expect(validateScopes([])).toEqual({ valid: true, invalid: [] });
  });
});

describe("getAvailableScopeNames", () => {
  it("returns exactly the keys of SCOPE_MAP", () => {
    expect(getAvailableScopeNames().sort()).toEqual(Object.keys(SCOPE_MAP).sort());
  });

  it("includes at least the default scopes", () => {
    const names = getAvailableScopeNames();
    for (const s of DEFAULT_SCOPES) {
      expect(names).toContain(s);
    }
  });
});
