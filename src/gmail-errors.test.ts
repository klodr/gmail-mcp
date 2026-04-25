import { describe, it, expect } from "vitest";
import { asGmailApiError, buildInvalidGrantPayload, isInvalidGrantError } from "./gmail-errors.js";

describe("asGmailApiError", () => {
  it("extracts an explicit numeric .code off an Error subclass", () => {
    const err = Object.assign(new Error("boom"), { code: 404 });
    const view = asGmailApiError(err);
    expect(view.code).toBe(404);
    expect(view.message).toBe("boom");
    expect(view.original).toBe(err);
  });

  it("falls back to response.status (GaxiosError shape) when .code is not a number", () => {
    const err = Object.assign(new Error("not found"), {
      response: { status: 404 },
    });
    expect(asGmailApiError(err).code).toBe(404);
  });

  it("prefers .code over response.status when both are numbers", () => {
    const err = Object.assign(new Error("conflict"), {
      code: 409,
      response: { status: 400 },
    });
    expect(asGmailApiError(err).code).toBe(409);
  });

  it("ignores a non-numeric .code (e.g. string 'ECONNRESET')", () => {
    const err = Object.assign(new Error("reset"), {
      code: "ECONNRESET",
      response: { status: 503 },
    });
    // string code is not numeric → view falls back to response.status
    expect(asGmailApiError(err).code).toBe(503);
  });

  it("returns undefined code when neither .code nor response.status is numeric", () => {
    const err = new Error("bare");
    expect(asGmailApiError(err).code).toBeUndefined();
  });

  it("coerces non-Error throwables to a string message", () => {
    const view = asGmailApiError("string thrown");
    expect(view.code).toBeUndefined();
    expect(view.message).toBe("string thrown");
    expect(view.original).toBe("string thrown");

    const numView = asGmailApiError(42);
    expect(numView.message).toBe("42");

    const nullView = asGmailApiError(null);
    expect(nullView.message).toBe("null");
  });

  it("preserves the original error reference (for { cause } forwarding)", () => {
    const err = new Error("cause-chain");
    const view = asGmailApiError(err);
    expect(view.original).toBe(err);
    // A re-thrown wrapper can attach the original without mutation.
    const wrapped = new Error(`Label op failed: ${view.message}`, { cause: view.original });
    expect(wrapped.cause).toBe(err);
  });
});

describe("isInvalidGrantError", () => {
  it("detects invalid_grant in a top-level error message", () => {
    expect(
      isInvalidGrantError(new Error("invalid_grant: Token has been expired or revoked.")),
    ).toBe(true);
  });

  it("is case-insensitive on the message", () => {
    expect(isInvalidGrantError(new Error("INVALID_GRANT"))).toBe(true);
  });

  it("detects invalid_grant in response.data.error (GaxiosError shape)", () => {
    const err = Object.assign(new Error("Request failed"), {
      response: { data: { error: "invalid_grant" } },
    });
    expect(isInvalidGrantError(err)).toBe(true);
  });

  it("detects invalid_grant in response.data.error_description", () => {
    const err = Object.assign(new Error("Request failed"), {
      response: {
        data: {
          error: "unauthorized_client",
          error_description: "invalid_grant: refresh token revoked",
        },
      },
    });
    expect(isInvalidGrantError(err)).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isInvalidGrantError(new Error("quota exceeded"))).toBe(false);
    expect(isInvalidGrantError(new Error("ECONNRESET"))).toBe(false);
  });

  it("matches the lazy-boot stub OAuth2Client error shape", () => {
    // Real google-auth-library text when `new OAuth2Client()` is queried
    // without credentials. The lazy-boot path needs this to flow into
    // the same INVALID_GRANT-shaped payload as a revoked refresh token.
    expect(
      isInvalidGrantError(
        new Error("No access, refresh token, API key or refresh handler callback is set."),
      ),
    ).toBe(true);
    expect(isInvalidGrantError(new Error("no credentials configured"))).toBe(true);
  });

  it("returns false for non-Error throwables", () => {
    expect(isInvalidGrantError("invalid_grant")).toBe(false);
    expect(isInvalidGrantError(null)).toBe(false);
    expect(isInvalidGrantError(undefined)).toBe(false);
    expect(isInvalidGrantError({ message: "invalid_grant" })).toBe(false);
  });

  it("ignores a numeric or non-string error field", () => {
    const err = Object.assign(new Error("other"), {
      response: { data: { error: 401, error_description: null } },
    });
    expect(isInvalidGrantError(err)).toBe(false);
  });
});

describe("buildInvalidGrantPayload", () => {
  it("returns a structured payload with the exact contract keys", () => {
    const payload = buildInvalidGrantPayload("/home/alice/.gmail-mcp/credentials.json");
    expect(payload).toEqual({
      code: "INVALID_GRANT",
      message: expect.stringContaining("Google"),
      recovery_action: expect.stringContaining("npx @klodr/gmail-mcp auth"),
      credential_path: "/home/alice/.gmail-mcp/credentials.json",
    });
  });

  it("surfaces the credential_path verbatim (no normalisation)", () => {
    const weird = "~/wherever/my-creds.json";
    expect(buildInvalidGrantPayload(weird).credential_path).toBe(weird);
  });

  it("has a stable code literal usable for client-side branching", () => {
    const payload = buildInvalidGrantPayload("p");
    // code is a literal — narrow typing guarantees exact match.
    expect(payload.code).toBe("INVALID_GRANT");
  });
});
