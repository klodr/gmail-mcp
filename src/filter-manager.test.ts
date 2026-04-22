import { describe, it, expect, vi } from "vitest";
import type { gmail_v1 } from "googleapis";
import {
  createFilter,
  listFilters,
  getFilter,
  deleteFilter,
  filterTemplates,
} from "./filter-manager.js";

type FiltersApi = {
  create: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

function mockGmail(): { gmail: gmail_v1.Gmail; filters: FiltersApi } {
  const filters: FiltersApi = {
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  };
  const gmail = {
    users: { settings: { filters } },
  } as unknown as gmail_v1.Gmail;
  return { gmail, filters };
}

function apiErr(status: number, message: string): Error {
  return Object.assign(new Error(message), { response: { status } });
}

describe("createFilter", () => {
  it("posts { criteria, action } to the API verbatim", async () => {
    const { gmail, filters } = mockGmail();
    filters.create.mockResolvedValue({ data: { id: "F1" } });
    const out = await createFilter(gmail, { from: "alice@example.com" }, { addLabelIds: ["L1"] });
    expect(out).toEqual({ id: "F1" });
    expect(filters.create).toHaveBeenCalledWith({
      userId: "me",
      requestBody: {
        criteria: { from: "alice@example.com" },
        action: { addLabelIds: ["L1"] },
      },
    });
  });

  it("reports a specific message on 400 (invalid filter)", async () => {
    const { gmail, filters } = mockGmail();
    filters.create.mockRejectedValue(apiErr(400, "Invalid criteria"));
    await expect(createFilter(gmail, {}, {})).rejects.toThrow(/Invalid filter criteria or action/);
  });

  it("wraps other failures generically", async () => {
    const { gmail, filters } = mockGmail();
    filters.create.mockRejectedValue(apiErr(500, "boom"));
    await expect(createFilter(gmail, {}, {})).rejects.toThrow(/Failed to create filter/);
  });
});

describe("listFilters", () => {
  it("returns filters + count from the response", async () => {
    const { gmail, filters } = mockGmail();
    filters.list.mockResolvedValue({
      data: { filter: [{ id: "F1" }, { id: "F2" }] },
    });
    const out = await listFilters(gmail);
    expect(out.count).toBe(2);
    expect(out.filters).toHaveLength(2);
  });

  it("handles the no-filters case (response.data.filter undefined)", async () => {
    const { gmail, filters } = mockGmail();
    filters.list.mockResolvedValue({ data: {} });
    const out = await listFilters(gmail);
    expect(out).toEqual({ filters: [], count: 0 });
  });

  it("wraps failures", async () => {
    const { gmail, filters } = mockGmail();
    filters.list.mockRejectedValue(new Error("boom"));
    await expect(listFilters(gmail)).rejects.toThrow(/Failed to list filters/);
  });
});

describe("getFilter", () => {
  it("fetches a specific filter by id", async () => {
    const { gmail, filters } = mockGmail();
    filters.get.mockResolvedValue({ data: { id: "F1", criteria: { from: "a@b" } } });
    const out = await getFilter(gmail, "F1");
    expect(out.id).toBe("F1");
    expect(filters.get).toHaveBeenCalledWith({ userId: "me", id: "F1" });
  });

  it("reports a specific 'not found' message on 404", async () => {
    const { gmail, filters } = mockGmail();
    filters.get.mockRejectedValue(apiErr(404, "not found"));
    await expect(getFilter(gmail, "ghost")).rejects.toThrow(/Filter with ID "ghost" not found/);
  });

  it("wraps other failures", async () => {
    const { gmail, filters } = mockGmail();
    filters.get.mockRejectedValue(apiErr(500, "boom"));
    await expect(getFilter(gmail, "F1")).rejects.toThrow(/Failed to get filter/);
  });
});

describe("deleteFilter", () => {
  it("deletes and returns a success payload", async () => {
    const { gmail, filters } = mockGmail();
    filters.delete.mockResolvedValue({ data: {} });
    const out = await deleteFilter(gmail, "F1");
    expect(out).toEqual({ success: true, message: 'Filter "F1" deleted successfully.' });
  });

  it("reports a specific 'not found' message on 404", async () => {
    const { gmail, filters } = mockGmail();
    filters.delete.mockRejectedValue(apiErr(404, "not found"));
    await expect(deleteFilter(gmail, "ghost")).rejects.toThrow(/Filter with ID "ghost" not found/);
  });

  it("wraps other failures", async () => {
    const { gmail, filters } = mockGmail();
    filters.delete.mockRejectedValue(apiErr(500, "boom"));
    await expect(deleteFilter(gmail, "F1")).rejects.toThrow(/Failed to delete filter/);
  });
});

describe("filterTemplates", () => {
  it("fromSender builds a matching criteria + label action (no archive)", () => {
    const r = filterTemplates.fromSender("alice@example.com", ["L1"]);
    expect(r.criteria).toEqual({ from: "alice@example.com" });
    expect(r.action).toEqual({ addLabelIds: ["L1"], removeLabelIds: undefined });
  });

  it("fromSender archives via removeLabelIds: ['INBOX']", () => {
    const r = filterTemplates.fromSender("a@b", [], true);
    expect(r.action.removeLabelIds).toEqual(["INBOX"]);
  });

  it("withSubject can mark-as-read by removing UNREAD", () => {
    const r = filterTemplates.withSubject("[bot]", ["L"], true);
    expect(r.criteria).toEqual({ subject: "[bot]" });
    expect(r.action.removeLabelIds).toEqual(["UNREAD"]);
  });

  it("withSubject without markAsRead leaves removeLabelIds undefined", () => {
    const r = filterTemplates.withSubject("[bot]");
    expect(r.action.removeLabelIds).toBeUndefined();
  });

  it("withAttachments sets hasAttachment criteria", () => {
    const r = filterTemplates.withAttachments(["Attach"]);
    expect(r.criteria).toEqual({ hasAttachment: true });
    expect(r.action.addLabelIds).toEqual(["Attach"]);
  });

  it("largeEmails encodes size + comparison", () => {
    const r = filterTemplates.largeEmails(10_000_000, ["Big"]);
    expect(r.criteria).toEqual({ size: 10_000_000, sizeComparison: "larger" });
  });

  it("containingText wraps the query in quotes and can add IMPORTANT", () => {
    const r = filterTemplates.containingText("secret", ["Audit"], true);
    expect(r.criteria).toEqual({ query: '"secret"' });
    expect(r.action.addLabelIds).toEqual(["Audit", "IMPORTANT"]);
  });

  it("mailingList builds an OR query with list: and subject:[id]", () => {
    const r = filterTemplates.mailingList("example-list");
    expect(r.criteria.query).toMatch(/list:example-list/);
    expect(r.criteria.query).toMatch(/subject:\[example-list\]/);
    // default archives → INBOX removed
    expect(r.action.removeLabelIds).toEqual(["INBOX"]);
  });

  it("mailingList keeps INBOX when archive=false", () => {
    const r = filterTemplates.mailingList("list", [], false);
    expect(r.action.removeLabelIds).toBeUndefined();
  });
});
