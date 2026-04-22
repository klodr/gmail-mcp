import { describe, it, expect } from "vitest";
import { asGmailApiError } from "./gmail-errors.js";

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
