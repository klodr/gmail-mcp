/**
 * Generic batch processor used by `batch_modify_emails` and
 * `batch_delete_emails`. Extracted from the legacy
 * `CallToolRequestSchema` switch in `src/index.ts` so the same code
 * path can be exercised by unit tests without spinning the whole MCP
 * dispatcher.
 *
 * Strategy: try each batch as a single concurrent group; if it throws,
 * fall back to processing each item individually so a single failure
 * does not poison the whole batch's results.
 */

export interface BatchOutcome<T, U> {
  successes: U[];
  failures: { item: T; error: Error }[];
}

/**
 * Process `items` in chunks of `batchSize`. Each chunk is passed to
 * `processFn` as a whole. If a chunk fails, every item in it is
 * retried individually.
 */
export async function processBatches<T, U>(
  items: T[],
  batchSize: number,
  processFn: (batch: T[]) => Promise<U[]>,
): Promise<BatchOutcome<T, U>> {
  const successes: U[] = [];
  const failures: { item: T; error: Error }[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    try {
      const results = await processFn(batch);
      successes.push(...results);
    } catch {
      // If the whole batch fails, retry each item individually so a
      // single bad item does not lose the rest of the batch's results.
      for (const item of batch) {
        try {
          const result = await processFn([item]);
          successes.push(...result);
        } catch (itemError) {
          failures.push({ item, error: itemError as Error });
        }
      }
    }
  }

  return { successes, failures };
}
