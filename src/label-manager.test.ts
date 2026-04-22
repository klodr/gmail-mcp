import { describe, it, expect, vi, beforeEach } from "vitest";
import type { gmail_v1 } from "googleapis";
import {
  DuplicateLabelError,
  SystemLabelProtectionError,
  createLabel,
  updateLabel,
  deleteLabel,
  listLabels,
  findLabelByName,
  getOrCreateLabel,
} from "./label-manager.js";

/**
 * Minimal mock of the gmail.users.labels surface that each test
 * re-configures via mockResolvedValue / mockRejectedValue. We cast
 * through `unknown` rather than `any` to keep the file lint-clean.
 */
type LabelsApi = {
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
};

function mockGmail(): { gmail: gmail_v1.Gmail; labels: LabelsApi } {
  const labels: LabelsApi = {
    create: vi.fn(),
    update: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
  };
  const gmail = { users: { labels } } as unknown as gmail_v1.Gmail;
  return { gmail, labels };
}

/** Build a GaxiosError-shaped object (code on the error OR on .response.status). */
function apiErr(status: number, message: string): Error {
  return Object.assign(new Error(message), { response: { status } });
}

describe("createLabel", () => {
  it("creates with defaulted visibility when none provided", async () => {
    const { gmail, labels } = mockGmail();
    labels.create.mockResolvedValue({ data: { id: "L1", name: "Foo" } });
    const out = await createLabel(gmail, "Foo");
    expect(out).toEqual({ id: "L1", name: "Foo" });
    expect(labels.create).toHaveBeenCalledWith({
      userId: "me",
      requestBody: {
        name: "Foo",
        messageListVisibility: "show",
        labelListVisibility: "labelShow",
      },
    });
  });

  it("passes through explicit visibility options", async () => {
    const { gmail, labels } = mockGmail();
    labels.create.mockResolvedValue({ data: { id: "L2" } });
    await createLabel(gmail, "Bar", {
      messageListVisibility: "hide",
      labelListVisibility: "labelHide",
    });
    expect(labels.create).toHaveBeenCalledWith({
      userId: "me",
      requestBody: {
        name: "Bar",
        messageListVisibility: "hide",
        labelListVisibility: "labelHide",
      },
    });
  });

  it("throws DuplicateLabelError on HTTP 409 (unambiguous duplicate)", async () => {
    const { gmail, labels } = mockGmail();
    labels.create.mockRejectedValue(apiErr(409, "already exists"));
    await expect(createLabel(gmail, "Foo")).rejects.toBeInstanceOf(DuplicateLabelError);
  });

  it("throws DuplicateLabelError on HTTP 400 ONLY if message corroborates", async () => {
    const { gmail, labels } = mockGmail();
    labels.create.mockRejectedValue(apiErr(400, "Label already exists (another)"));
    await expect(createLabel(gmail, "Foo")).rejects.toBeInstanceOf(DuplicateLabelError);
  });

  it("does NOT treat a 400 without 'already exists' as a duplicate", async () => {
    const { gmail, labels } = mockGmail();
    labels.create.mockRejectedValue(apiErr(400, "Invalid label name"));
    const p = createLabel(gmail, "!!!");
    await expect(p).rejects.not.toBeInstanceOf(DuplicateLabelError);
    await expect(p).rejects.toThrow(/Failed to create label/);
  });

  it("treats network errors (no status) with matching message as duplicate", async () => {
    const { gmail, labels } = mockGmail();
    // No status/code — only .message
    labels.create.mockRejectedValue(new Error("already exists"));
    await expect(createLabel(gmail, "Foo")).rejects.toBeInstanceOf(DuplicateLabelError);
  });

  it("wraps a generic failure in a 'Failed to create label' error with cause", async () => {
    const { gmail, labels } = mockGmail();
    const original = apiErr(500, "Server error");
    labels.create.mockRejectedValue(original);
    try {
      await createLabel(gmail, "Foo");
      expect.fail("should have thrown");
    } catch (err: unknown) {
      expect((err as Error).message).toContain("Failed to create label");
      expect((err as Error).cause).toBe(original);
    }
  });
});

describe("updateLabel", () => {
  it("passes updates through to the API", async () => {
    const { gmail, labels } = mockGmail();
    labels.update.mockResolvedValue({ data: { id: "L1", name: "Renamed" } });
    const out = await updateLabel(gmail, "L1", { name: "Renamed" });
    expect(out).toEqual({ id: "L1", name: "Renamed" });
    expect(labels.update).toHaveBeenCalledWith({
      userId: "me",
      id: "L1",
      requestBody: { name: "Renamed" },
    });
  });

  it("reports a specific 'not found' message on 404", async () => {
    const { gmail, labels } = mockGmail();
    labels.update.mockRejectedValue(apiErr(404, "not found"));
    await expect(updateLabel(gmail, "missing", { name: "X" })).rejects.toThrow(
      /Label with ID "missing" not found/,
    );
  });

  it("wraps other failures generically", async () => {
    const { gmail, labels } = mockGmail();
    labels.update.mockRejectedValue(apiErr(500, "Internal"));
    await expect(updateLabel(gmail, "L1", { name: "X" })).rejects.toThrow(/Failed to update label/);
  });
});

describe("deleteLabel", () => {
  it("deletes a user label after confirming type=user via get", async () => {
    const { gmail, labels } = mockGmail();
    labels.get.mockResolvedValue({ data: { id: "L1", name: "Work", type: "user" } });
    labels.delete.mockResolvedValue({ data: {} });
    const out = await deleteLabel(gmail, "L1");
    expect(out).toEqual({ success: true, message: 'Label "Work" deleted successfully.' });
    expect(labels.delete).toHaveBeenCalledWith({ userId: "me", id: "L1" });
  });

  it("refuses to delete a system label", async () => {
    const { gmail, labels } = mockGmail();
    labels.get.mockResolvedValue({
      data: { id: "INBOX", name: "INBOX", type: "system" },
    });
    await expect(deleteLabel(gmail, "INBOX")).rejects.toBeInstanceOf(SystemLabelProtectionError);
    expect(labels.delete).not.toHaveBeenCalled();
  });

  it("re-throws SystemLabelProtectionError with its specific message intact", async () => {
    const { gmail, labels } = mockGmail();
    labels.get.mockResolvedValue({ data: { id: "TRASH", type: "system" } });
    await expect(deleteLabel(gmail, "TRASH")).rejects.toThrow(
      'Cannot delete system label with ID "TRASH"',
    );
  });

  it("reports a specific 'not found' message on 404 from get", async () => {
    const { gmail, labels } = mockGmail();
    labels.get.mockRejectedValue(apiErr(404, "not found"));
    await expect(deleteLabel(gmail, "ghost")).rejects.toThrow(/Label with ID "ghost" not found/);
  });

  it("wraps other failures generically", async () => {
    const { gmail, labels } = mockGmail();
    labels.get.mockRejectedValue(apiErr(500, "boom"));
    await expect(deleteLabel(gmail, "L1")).rejects.toThrow(/Failed to delete label/);
  });
});

describe("listLabels", () => {
  it("groups labels by type and returns counts", async () => {
    const { gmail, labels } = mockGmail();
    labels.list.mockResolvedValue({
      data: {
        labels: [
          { id: "INBOX", type: "system" },
          { id: "Lu1", type: "user" },
          { id: "Lu2", type: "user" },
        ],
      },
    });
    const out = await listLabels(gmail);
    expect(out.count).toEqual({ total: 3, system: 1, user: 2 });
    expect(out.system).toHaveLength(1);
    expect(out.user).toHaveLength(2);
  });

  it("handles an empty label set", async () => {
    const { gmail, labels } = mockGmail();
    labels.list.mockResolvedValue({ data: {} });
    const out = await listLabels(gmail);
    expect(out.count).toEqual({ total: 0, system: 0, user: 0 });
  });

  it("wraps API failures", async () => {
    const { gmail, labels } = mockGmail();
    labels.list.mockRejectedValue(new Error("boom"));
    await expect(listLabels(gmail)).rejects.toThrow(/Failed to list labels/);
  });
});

describe("findLabelByName", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a label matching case-insensitively", async () => {
    const { gmail, labels } = mockGmail();
    labels.list.mockResolvedValue({
      data: { labels: [{ id: "L1", name: "WORK", type: "user" }] },
    });
    const out = await findLabelByName(gmail, "work");
    expect(out?.id).toBe("L1");
  });

  it("returns null when no match", async () => {
    const { gmail, labels } = mockGmail();
    labels.list.mockResolvedValue({ data: { labels: [] } });
    expect(await findLabelByName(gmail, "x")).toBeNull();
  });

  it("wraps upstream listLabels failure", async () => {
    const { gmail, labels } = mockGmail();
    labels.list.mockRejectedValue(new Error("boom"));
    await expect(findLabelByName(gmail, "x")).rejects.toThrow(/Failed to find label/);
  });
});

describe("getOrCreateLabel", () => {
  it("returns the existing label when found on the first pass", async () => {
    const { gmail, labels } = mockGmail();
    labels.list.mockResolvedValue({
      data: { labels: [{ id: "L1", name: "Foo", type: "user" }] },
    });
    const out = await getOrCreateLabel(gmail, "Foo");
    expect(out?.id).toBe("L1");
    expect(labels.create).not.toHaveBeenCalled();
  });

  it("creates the label when not found", async () => {
    const { gmail, labels } = mockGmail();
    labels.list.mockResolvedValue({ data: { labels: [] } });
    labels.create.mockResolvedValue({ data: { id: "New", name: "Foo" } });
    const out = await getOrCreateLabel(gmail, "Foo");
    expect(out?.id).toBe("New");
  });

  it("recovers from a TOCTOU duplicate by re-fetching", async () => {
    const { gmail, labels } = mockGmail();
    // First list → not found. createLabel races → 409. Second list → found.
    labels.list.mockResolvedValueOnce({ data: { labels: [] } }).mockResolvedValueOnce({
      data: { labels: [{ id: "Raced", name: "Foo", type: "user" }] },
    });
    labels.create.mockRejectedValue(apiErr(409, "already exists"));
    const out = await getOrCreateLabel(gmail, "Foo");
    expect(out?.id).toBe("Raced");
  });

  it("re-throws when the TOCTOU rescan still cannot find the label", async () => {
    const { gmail, labels } = mockGmail();
    labels.list.mockResolvedValue({ data: { labels: [] } });
    labels.create.mockRejectedValue(apiErr(409, "already exists"));
    await expect(getOrCreateLabel(gmail, "Foo")).rejects.toThrow(/Failed to get or create label/);
  });

  it("wraps non-duplicate create errors without a rescan", async () => {
    const { gmail, labels } = mockGmail();
    labels.list.mockResolvedValue({ data: { labels: [] } });
    labels.create.mockRejectedValue(apiErr(500, "boom"));
    await expect(getOrCreateLabel(gmail, "Foo")).rejects.toThrow(/Failed to get or create label/);
  });
});
