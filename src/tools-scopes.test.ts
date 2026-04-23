import { describe, it, expect } from "vitest";
import { toolDefinitions } from "./tools.js";

describe("delete tools require mail.google.com (Google API requirement)", () => {
  it("delete_email is gated on mail.google.com, not gmail.modify", () => {
    const t = toolDefinitions.find((d) => d.name === "delete_email");
    expect(t).toBeDefined();
    // gmail.modify can move to Trash but cannot purge — Google API
    // returns HTTP 403 on users.messages.delete with that scope. The
    // only scope that authorizes permanent delete is mail.google.com.
    expect(t!.scopes).toEqual(["mail.google.com"]);
  });

  it("batch_delete_emails has the same requirement", () => {
    const t = toolDefinitions.find((d) => d.name === "batch_delete_emails");
    expect(t).toBeDefined();
    expect(t!.scopes).toEqual(["mail.google.com"]);
  });
});
