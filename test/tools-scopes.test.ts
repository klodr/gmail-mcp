import { describe, it, expect } from "vitest";
import { toolDefinitions } from "../src/tools.js";
import { hasScope } from "../src/scopes.js";

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

describe("mail.google.com is a superset of the mail scopes, not of settings", () => {
  const visible = (scopes: string[]) =>
    toolDefinitions.filter((t) => hasScope(scopes, t.scopes)).map((t) => t.name);

  it("exposes the read, send, modify and label tools to a mail.google.com-only token", () => {
    const names = visible(["mail.google.com"]);
    for (const tool of [
      "read_email",
      "search_emails",
      "send_email",
      "modify_email",
      "create_label",
    ]) {
      expect(names, tool).toContain(tool);
    }
  });

  it("also accepts the bare https://mail.google.com/ URL form", () => {
    expect(visible(["https://mail.google.com/"])).toEqual(visible(["mail.google.com"]));
  });

  it("does not expose the settings-scoped filter tools", () => {
    const names = visible(["mail.google.com"]);
    for (const tool of ["list_filters", "create_filter", "delete_filter"]) {
      expect(names, tool).not.toContain(tool);
    }
    expect(hasScope(["mail.google.com"], ["gmail.settings.basic"])).toBe(false);
    expect(hasScope(["mail.google.com"], ["gmail.settings.sharing"])).toBe(false);
  });

  it("matches the union of what gmail.modify and mail.google.com expose on their own", () => {
    const full = visible(["mail.google.com"]);
    for (const tool of visible(["gmail.modify"])) {
      expect(full, tool).toContain(tool);
    }
  });
});
