import { describe, expect, it } from "vitest";
import { PROMPTS, getPrompt, listPrompts } from "./prompts.js";

describe("prompts: listPrompts", () => {
  it("exposes exactly the 6 slash commands requested by the maintainer", () => {
    const names = listPrompts()
      .map((p) => p.name)
      .sort();
    expect(names).toEqual([
      "detect-phishing",
      "detect-spam",
      "inbox-reclass",
      "unread-emails",
      "unread-stale",
      "unread-triage",
    ]);
  });

  it("every prompt has a non-empty title and description", () => {
    for (const p of PROMPTS) {
      expect(p.title).toBeTruthy();
      expect(p.description).toBeTruthy();
    }
  });

  it("unread-stale declares exactly one required `olderThan` arg", () => {
    const p = PROMPTS.find((p) => p.name === "unread-stale");
    expect(p).toBeDefined();
    expect(p?.arguments).toHaveLength(1);
    expect(p?.arguments[0]?.name).toBe("olderThan");
    expect(p?.arguments[0]?.required).toBe(true);
  });

  it("the other 5 prompts take no args", () => {
    for (const name of [
      "unread-emails",
      "inbox-reclass",
      "detect-phishing",
      "detect-spam",
      "unread-triage",
    ]) {
      const p = PROMPTS.find((p) => p.name === name);
      expect(p?.arguments).toEqual([]);
    }
  });
});

describe("prompts: getPrompt", () => {
  it("throws on unknown prompt name", () => {
    expect(() => getPrompt("does-not-exist", {})).toThrow(/Unknown prompt/);
  });

  it("unread-emails directs the LLM to search_emails with is:unread", () => {
    const r = getPrompt("unread-emails", {});
    expect(r.messages).toHaveLength(1);
    const text = r.messages[0]?.content.text ?? "";
    expect(text).toContain("search_emails");
    expect(text).toContain("is:unread");
    expect(text).toContain("in:inbox");
  });

  it("unread-stale embeds the caller-supplied olderThan in the query", () => {
    const r = getPrompt("unread-stale", { olderThan: "14d" });
    const text = r.messages[0]?.content.text ?? "";
    expect(text).toContain("older_than:14d");
  });

  it("unread-stale rejects args without olderThan", () => {
    expect(() => getPrompt("unread-stale", {})).toThrow();
  });

  it("unread-stale rejects extra unknown args (strict schema)", () => {
    expect(() => getPrompt("unread-stale", { olderThan: "7d", extraField: "x" })).toThrow();
  });

  it("inbox-reclass mentions all four target labels by name", () => {
    const r = getPrompt("inbox-reclass", {});
    const text = r.messages[0]?.content.text ?? "";
    expect(text).toContain("Newsletters");
    expect(text).toContain("Notifications");
    expect(text).toContain("Social");
    expect(text).toContain("Forums");
    expect(text).toContain("get_or_create_label");
    expect(text).toContain("batch_modify_emails");
  });

  it("inbox-reclass explicitly tells the LLM not to remove the INBOX label", () => {
    const text = getPrompt("inbox-reclass", {}).messages[0]?.content.text ?? "";
    expect(text).toMatch(/do NOT also remove the `INBOX`/i);
  });

  it("detect-phishing creates a Phishing label and lists indicators", () => {
    const text = getPrompt("detect-phishing", {}).messages[0]?.content.text ?? "";
    expect(text).toContain("Phishing");
    expect(text).toContain("get_or_create_label");
    // At least one phishing indicator from the list
    expect(text.toLowerCase()).toMatch(/urgency|dmarc|spf|credential|impersonating/);
  });

  it("detect-spam uses a custom `Spam` label distinct from Gmail's SPAM system label", () => {
    const text = getPrompt("detect-spam", {}).messages[0]?.content.text ?? "";
    expect(text).toContain("Spam");
    expect(text.toLowerCase()).toContain("distinct from");
  });

  it("unread-triage produces a per-category table with archive/reply/delete recommendations", () => {
    const text = getPrompt("unread-triage", {}).messages[0]?.content.text ?? "";
    expect(text.toLowerCase()).toContain("archive");
    expect(text.toLowerCase()).toContain("reply");
    expect(text.toLowerCase()).toContain("delete");
    expect(text).toContain("Work");
    expect(text).toContain("Personal");
  });

  it("each returned prompt has exactly one user-role text message", () => {
    for (const p of PROMPTS) {
      const args = p.arguments.some((a) => a.required) ? { olderThan: "7d" } : {};
      const r = getPrompt(p.name, args);
      expect(r.messages).toHaveLength(1);
      expect(r.messages[0]?.role).toBe("user");
      expect(r.messages[0]?.content.type).toBe("text");
      expect((r.messages[0]?.content.text ?? "").length).toBeGreaterThan(50);
    }
  });
});
