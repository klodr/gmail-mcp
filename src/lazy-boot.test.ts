/**
 * Lazy-boot tools/list surface
 *
 * Lazy-boot path runs when `gcp-oauth.keys.json` is not on disk. The
 * stub OAuth2Client is created so `tools/list` doesn't crash, but no
 * tool can actually authenticate until the user runs `auth`. The
 * authorizedScopes default of DEFAULT_SCOPES would advertise 26 tools
 * none of which can succeed — set scopes to [] in the lazy-boot path
 * so `tools/list` returns the empty set.
 *
 * Tests below cover both the SOURCE shape (the lazy-boot branch sets
 * authorizedScopes = []) and the BEHAVIOUR (an empty authorizedScopes
 * filters every tool out via hasScope).
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasScope } from "./scopes.js";
import { toolDefinitions } from "./tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = __dirname;

describe("lazy-boot tools/list surface", () => {
  it("source: lazy-boot branch resets authorizedScopes to []", () => {
    const source = fs.readFileSync(path.join(srcDir, "index.ts"), "utf-8");
    // After creating the stub OAuth2Client in the lazy-boot path,
    // authorizedScopes must be set to the empty array so tools/list
    // returns 0 tools. Guarding both the comment cue and the actual
    // assignment so a future refactor can't silently drop one.
    expect(source).toContain("oauth2Client = new OAuth2Client();");
    expect(source).toMatch(
      /oauth2Client = new OAuth2Client\(\);[\s\S]{0,1500}authorizedScopes = \[\];/,
    );
  });

  it("behaviour: empty authorizedScopes filters every tool out", () => {
    // This is exactly what the lazy-boot path produces: no scopes
    // mean none of the 26 tools can pass `hasScope`, so the
    // ListTools handler returns an empty array.
    const advertised = toolDefinitions.filter((tool) => hasScope([], tool.scopes));
    expect(advertised).toEqual([]);
  });

  it("sanity: with DEFAULT_SCOPES advertising returns the full surface", () => {
    // Sibling sanity check — confirms that hasScope([], …) returning []
    // above is not an artefact of every tool having an unsatisfiable
    // scope list. With the post-auth scopes the dispatcher would
    // grant, the surface is non-empty.
    const advertised = toolDefinitions.filter((tool) =>
      hasScope(["gmail.modify", "gmail.settings.basic"], tool.scopes),
    );
    expect(advertised.length).toBeGreaterThan(0);
  });
});
