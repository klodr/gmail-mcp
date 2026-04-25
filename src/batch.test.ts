import { describe, it, expect, vi } from "vitest";
import { processBatches } from "./batch.js";

describe("processBatches", () => {
  it("returns empty outcome for an empty input list", async () => {
    const fn = vi.fn(async (batch: number[]) => batch);
    const result = await processBatches([], 10, fn);
    expect(result.successes).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("processes every item in a single happy-path batch", async () => {
    const items = [1, 2, 3];
    const fn = vi.fn(async (batch: number[]) => batch.map((n) => n * 10));
    const result = await processBatches(items, 10, fn);
    expect(result.successes).toEqual([10, 20, 30]);
    expect(result.failures).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith([1, 2, 3]);
  });

  it("respects batchSize and issues one call per chunk", async () => {
    const items = [1, 2, 3, 4, 5];
    const fn = vi.fn(async (batch: number[]) => batch);
    await processBatches(items, 2, fn);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn).toHaveBeenNthCalledWith(1, [1, 2]);
    expect(fn).toHaveBeenNthCalledWith(2, [3, 4]);
    expect(fn).toHaveBeenNthCalledWith(3, [5]);
  });

  it("falls back to per-item retry when a batch throws, surfacing partial success", async () => {
    const items = [1, 2, 3];
    let call = 0;
    const fn = vi.fn(async (batch: number[]) => {
      call += 1;
      // First call (the whole batch) throws; subsequent per-item calls
      // succeed for items 1 and 3, throw for item 2.
      if (call === 1) throw new Error("whole batch failed");
      if (batch.length === 1 && batch[0] === 2) throw new Error("item 2 is poison");
      return batch.map((n) => n * 100);
    });

    const result = await processBatches(items, 3, fn);
    expect(result.successes).toEqual([100, 300]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.item).toBe(2);
    expect(result.failures[0]?.error.message).toBe("item 2 is poison");
  });

  it("collects every item as a failure when batch + every retry throws", async () => {
    const items = ["a", "b"];
    const fn = vi.fn(async () => {
      throw new Error("nothing works");
    });
    const result = await processBatches(items, 5, fn);
    expect(result.successes).toEqual([]);
    expect(result.failures).toHaveLength(2);
    expect(result.failures.map((f) => f.item)).toEqual(["a", "b"]);
    expect(result.failures.every((f) => f.error.message === "nothing works")).toBe(true);
  });

  it("preserves the order of successes across multiple batches", async () => {
    const items = [10, 20, 30, 40];
    const fn = vi.fn(async (batch: number[]) => batch.map((n) => `#${n}`));
    const result = await processBatches(items, 2, fn);
    expect(result.successes).toEqual(["#10", "#20", "#30", "#40"]);
  });
});
