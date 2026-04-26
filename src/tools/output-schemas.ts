/**
 * Output schemas for the MCP `outputSchema` contract.
 *
 * The MCP protocol's `tools/list` exposes an optional `outputSchema`
 * field per tool — a JSON-Schema-compatible Zod shape that describes
 * the `structuredContent` an agent will receive on a successful
 * tool call. The SDK validates each `structuredContent` payload
 * against the schema before emitting, so a regression that drops a
 * field or returns the wrong type fails at the MCP boundary instead
 * of silently producing a malformed agent input.
 *
 * **Coverage policy.** Only tools that emit a JSON-shaped
 * `structuredContent` whose contract has been hand-audited carry an
 * outputSchema in this first wave. Tools that emit free-form text
 * (e.g., `send_email` → "Email sent successfully: <id>") have no
 * structured payload to validate; adding outputSchema to them would
 * require a behaviour change in the handler (emit JSON instead) and
 * is intentionally deferred to per-tool follow-up PRs to keep the
 * blast radius small.
 *
 * **First wave (this PR)**: `download_email` only. The other
 * JSON-output tools (`get_thread`, `list_inbox_threads`,
 * `get_inbox_with_threads`, `pair_recipient`) need their actual
 * emit shape pinned + a schema co-designed with the handler return
 * type — tracked under `docs/ROADMAP.md` for the next minor
 * release.
 *
 * Mirrors `klodr/mercury-invoicing-mcp` and `klodr/faxdrop-mcp`
 * once they adopt the same pattern.
 */

import { z, type ZodRawShape } from "zod";

/**
 * `download_email` writes a file inside `GMAIL_MCP_DOWNLOAD_DIR`
 * and returns metadata about the saved artifact + the message
 * headers that drove the filename. Emitted by every successful
 * `download_email` call (json/eml/txt/html — the format only
 * affects the file content, the JSON envelope is identical).
 *
 * The `attachments` array entries each carry the metadata an
 * agent needs to call `download_attachment` next: filename
 * (display), mimeType (content-type negotiation), size (bandwidth
 * planning), and attachmentId (the Gmail-side handle). All four
 * are optional because Gmail's `Schema$MessagePart` only
 * guarantees `body` — every other field can be absent on
 * pathological MIME shapes.
 */
export const downloadEmailOutputSchema = {
  status: z.literal("saved"),
  path: z.string(),
  size: z.number().int().nonnegative(),
  messageId: z.string(),
  subject: z.string(),
  from: z.string(),
  date: z.string(),
  attachments: z.array(
    z.object({
      filename: z.string().optional(),
      mimeType: z.string().optional(),
      size: z.number().optional(),
      attachmentId: z.string().optional(),
    }),
  ),
} satisfies ZodRawShape;
