import emailAddresses from "email-addresses";
import { z } from "zod";

// Gmail API IDs (messageId, threadId, labelId, attachmentId) are base64url
// strings. Bounding them (non-empty, ≤ 256 chars, base64url charset) stops
// a prompt-injected agent from forging megabyte-sized IDs that would burn
// a round-trip and then leak their prefix through batch error logs.
const GmailIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

// User-supplied filesystem paths. The attachment jail in `src/utl.ts`
// (assertAttachmentPathAllowed) is the load-bearing check at runtime,
// but a schema-level guard rejects the worst shapes before Zod would
// otherwise accept them — empty strings, absurdly long payloads,
// CRLF/NUL injection into a downstream filename log. 4096 chars is the
// effective filesystem path limit on every Linux we ship to; macOS is
// 1024 but we accept the wider bound rather than special-casing.
const FilePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !/[\0\r\n]/.test(p), "Path must not contain NUL or newline characters");

// Some MCP clients (Claude Code SDK is the one that put the bug in sharp
// relief — upstream GongRzhe#95/#96) serialize tool arguments with strict
// JSON so an `array` parameter arrives as the literal string `'["a","b"]'`
// and a `number` parameter as `'10'`. A bare `z.array(...)` / `z.number()`
// then rejects the call with "Expected array, received string".
//
// Workaround: preprocess to accept the JSON-stringified form too.
// `z.coerce.number()` already handles strings natively in Zod 4, so we only
// need a helper for array-like fields.
// `z.preprocess(..., z.array(inner))` returns a ZodPipe whose output type
// is a plain array and which does NOT expose `.max()` / `.min()` on the
// pipe itself. Pushing the length bound into the inner schema keeps the
// preprocess wrapper transparent to the call site, so fields can still
// declare `coerceArray(X, { max: 1000 })`.
const coerceArrayPreprocess = (val: unknown) => {
  if (typeof val !== "string") return val;
  // Only try JSON.parse on a value that at least looks like an array
  // literal, otherwise `"foo,bar"` would not round-trip and the error
  // from z.array() would shift from "Expected array, received string"
  // to the equally-misleading "Unexpected token f in JSON".
  const trimmed = val.trim();
  if (!trimmed.startsWith("[")) return val;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed : val;
  } catch {
    return val;
  }
};

const coerceArray = <T extends z.ZodTypeAny>(inner: T, opts?: { max?: number }) => {
  const arr = opts?.max !== undefined ? z.array(inner).max(opts.max) : z.array(inner);
  return z.preprocess(coerceArrayPreprocess, arr);
};

// Scoped integer coercion. `z.coerce.number()` is too permissive — it
// converts `true → 1`, `false → 0`, `null → 0`, `[] → 0`, which silently
// accepts malformed JSON from a loosely-typed caller. We only want to
// rescue string-encoded integers from strict-JSON clients (Claude Code
// SDK), not cross the type barrier.
//
// Preprocess passes numbers through untouched, coerces strings that
// parse as finite numbers, and leaves every other type alone so the
// inner `z.number().int()` rejects it with the expected "Expected
// number" error rather than silently widening.
//
// Bounds are declared via the options bag (same pattern as coerceArray)
// because `z.preprocess(fn, z.number().int())` returns a ZodPipe whose
// `.min()` / `.max()` are not directly chainable.
const coerceIntPreprocess = (val: unknown): unknown => {
  if (typeof val === "string") {
    // Strict decimal-integer match only. The naive `Number(trimmed)`
    // would silently accept scientific notation (`"1e2"` → 100) and
    // hex (`"0x10"` → 16), both well beyond the "stringified digits
    // from a strict-JSON client" contract we advertise. A regex keeps
    // the coercion surface narrow and predictable.
    const trimmed = val.trim();
    if (!/^-?\d+$/.test(trimmed)) return val;
    return Number(trimmed);
  }
  return val;
};

const coerceInt = (opts?: { min?: number; max?: number }) => {
  let inner = z.number().int();
  if (opts?.min !== undefined) inner = inner.min(opts.min);
  if (opts?.max !== undefined) inner = inner.max(opts.max);
  return z.preprocess(coerceIntPreprocess, inner);
};

// Schema definitions
export const SendEmailSchema = z.object({
  to: coerceArray(z.string()).describe("List of recipient email addresses"),
  subject: z.string().describe("Email subject"),
  body: z
    .string()
    .describe("Email body content (used for text/plain or when htmlBody not provided)"),
  from: z
    .string()
    .optional()
    .describe(
      "Sender email address (must be a configured send-as alias in Gmail settings). Defaults to account's default send-as address if not specified.",
    ),
  htmlBody: z.string().optional().describe("HTML version of the email body"),
  mimeType: z
    .enum(["text/plain", "text/html", "multipart/alternative"])
    .optional()
    .default("text/plain")
    .describe("Email content type"),
  cc: coerceArray(z.string()).optional().describe("List of CC recipients"),
  bcc: coerceArray(z.string()).optional().describe("List of BCC recipients"),
  threadId: GmailIdSchema.optional().describe("Thread ID to reply to"),
  // inReplyTo is an RFC 5322 Message-ID (e.g. `<abc@host>`), not a
  // Gmail API ID — different charset, kept out of GmailIdSchema. Bound
  // the length at the RFC's line limit (998 chars) to block unbounded
  // z.string() DoS without constraining the legitimate form.
  inReplyTo: z
    .string()
    .max(998)
    .optional()
    .describe("RFC 5322 Message-ID being replied to (e.g. <abc@host>, max 998 chars)"),
  attachments: coerceArray(FilePathSchema)
    .optional()
    .describe("List of file paths to attach to the email"),
});

// Gmail's own web UI clips message bodies at ~102 KB of combined text/HTML
// (images excluded). Matching that threshold means the LLM sees the same
// payload a human opening the message would see — identical UX. The
// `[Message clipped]` marker we emit matches Gmail's own label verbatim.
const GMAIL_CLIP_BYTES = 102 * 1024; // 104_448

export const ReadEmailSchema = z.object({
  messageId: GmailIdSchema.describe("ID of the email message to retrieve"),
  format: z
    .enum(["full", "summary", "headers_only"])
    .optional()
    .default("full")
    .describe(
      "Response depth: 'full' (default — headers + body + attachment list), 'summary' (headers + first 500 bytes of body, no attachments), 'headers_only' (no body, no attachments). Pick the lightest format that answers your question to keep the conversation's context budget for other calls.",
    ),
  maxBodyLength: coerceInt({ min: 0, max: 1_048_576 })
    .optional()
    .default(GMAIL_CLIP_BYTES)
    .describe(
      "Maximum body size in bytes. 0 disables truncation. Default 104448 (102 KB) matches Gmail's web UI clipping threshold so the response mirrors what a human opening the message would see, and the emitted '[Message clipped]' marker matches Gmail's own label. Lower the cap (e.g. 10000) when sampling many messages in a single conversation to preserve the LLM's context budget; raise it (up to 1 MB) or set 0 when you specifically need the unredacted payload.",
    ),
  includeAttachments: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Include the attachment metadata list (filename / MIME / size / ID). Set to false to shrink the response when you already know the message has many attachments and aren't going to act on them.",
    ),
});

export const SearchEmailsSchema = z.object({
  query: z.string().describe("Gmail search query (e.g., 'from:example@gmail.com')"),
  maxResults: coerceInt({ min: 1, max: 500 })
    .optional()
    .describe("Maximum number of results to return (1-500, default 10)"),
});

export const ModifyEmailSchema = z.object({
  messageId: GmailIdSchema.describe("ID of the email message to modify"),
  labelIds: coerceArray(GmailIdSchema).optional().describe("List of label IDs to apply"),
  addLabelIds: coerceArray(GmailIdSchema)
    .optional()
    .describe("List of label IDs to add to the message"),
  removeLabelIds: coerceArray(GmailIdSchema)
    .optional()
    .describe("List of label IDs to remove from the message"),
});

export const DeleteEmailSchema = z.object({
  messageId: GmailIdSchema.describe("ID of the email message to delete"),
});

export const ListEmailLabelsSchema = z.object({}).describe("Retrieves all available Gmail labels");

export const CreateLabelSchema = z
  .object({
    name: z.string().describe("Name for the new label"),
    messageListVisibility: z
      .enum(["show", "hide"])
      .optional()
      .describe("Whether to show or hide the label in the message list"),
    labelListVisibility: z
      .enum(["labelShow", "labelShowIfUnread", "labelHide"])
      .optional()
      .describe("Visibility of the label in the label list"),
  })
  .describe("Creates a new Gmail label");

export const UpdateLabelSchema = z
  .object({
    id: GmailIdSchema.describe("ID of the label to update"),
    name: z.string().optional().describe("New name for the label"),
    messageListVisibility: z
      .enum(["show", "hide"])
      .optional()
      .describe("Whether to show or hide the label in the message list"),
    labelListVisibility: z
      .enum(["labelShow", "labelShowIfUnread", "labelHide"])
      .optional()
      .describe("Visibility of the label in the label list"),
  })
  .describe("Updates an existing Gmail label");

export const DeleteLabelSchema = z
  .object({
    id: GmailIdSchema.describe("ID of the label to delete"),
  })
  .describe("Deletes a Gmail label");

export const GetOrCreateLabelSchema = z
  .object({
    name: z.string().describe("Name of the label to get or create"),
    messageListVisibility: z
      .enum(["show", "hide"])
      .optional()
      .describe("Whether to show or hide the label in the message list"),
    labelListVisibility: z
      .enum(["labelShow", "labelShowIfUnread", "labelHide"])
      .optional()
      .describe("Visibility of the label in the label list"),
  })
  .describe("Gets an existing label by name or creates it if it doesn't exist");

export const BatchModifyEmailsSchema = z.object({
  messageIds: coerceArray(GmailIdSchema, { max: 1000 }).describe(
    "List of message IDs to modify (max 1000 per call)",
  ),
  addLabelIds: coerceArray(GmailIdSchema)
    .optional()
    .describe("List of label IDs to add to all messages"),
  removeLabelIds: coerceArray(GmailIdSchema)
    .optional()
    .describe("List of label IDs to remove from all messages"),
  batchSize: coerceInt({ min: 1, max: 100 })
    .optional()
    .default(50)
    .describe("Messages per batch (1-100, default 50)"),
});

export const BatchDeleteEmailsSchema = z.object({
  messageIds: coerceArray(GmailIdSchema, { max: 1000 }).describe(
    "List of message IDs to delete (max 1000 per call)",
  ),
  batchSize: coerceInt({ min: 1, max: 100 })
    .optional()
    .default(50)
    .describe("Messages per batch (1-100, default 50)"),
});

export const CreateFilterSchema = z
  .object({
    criteria: z
      .object({
        from: z.string().optional().describe("Sender email address to match"),
        to: z.string().optional().describe("Recipient email address to match"),
        subject: z.string().optional().describe("Subject text to match"),
        query: z.string().optional().describe("Gmail search query (e.g., 'has:attachment')"),
        negatedQuery: z.string().optional().describe("Text that must NOT be present"),
        hasAttachment: z.boolean().optional().describe("Whether to match emails with attachments"),
        excludeChats: z.boolean().optional().describe("Whether to exclude chat messages"),
        size: coerceInt({ min: 0 }).optional().describe("Email size in bytes"),
        sizeComparison: z
          .enum(["unspecified", "smaller", "larger"])
          .optional()
          .describe("Size comparison operator"),
      })
      .describe("Criteria for matching emails"),
    action: z
      .object({
        addLabelIds: coerceArray(GmailIdSchema)
          .optional()
          .describe("Label IDs to add to matching emails"),
        removeLabelIds: coerceArray(GmailIdSchema)
          .optional()
          .describe("Label IDs to remove from matching emails"),
        forward: z.string().optional().describe("Email address to forward matching emails to"),
      })
      .describe("Actions to perform on matching emails"),
  })
  .describe("Creates a new Gmail filter");

export const ListFiltersSchema = z.object({}).describe("Retrieves all Gmail filters");

export const GetFilterSchema = z
  .object({
    filterId: GmailIdSchema.describe("ID of the filter to retrieve"),
  })
  .describe("Gets details of a specific Gmail filter");

export const DeleteFilterSchema = z
  .object({
    filterId: GmailIdSchema.describe("ID of the filter to delete"),
  })
  .describe("Deletes a Gmail filter");

export const CreateFilterFromTemplateSchema = z
  .object({
    template: z
      .enum([
        "fromSender",
        "withSubject",
        "withAttachments",
        "largeEmails",
        "containingText",
        "mailingList",
      ])
      .describe("Pre-defined filter template to use"),
    parameters: z
      .object({
        senderEmail: z.string().optional().describe("Sender email (for fromSender template)"),
        subjectText: z.string().optional().describe("Subject text (for withSubject template)"),
        searchText: z
          .string()
          .optional()
          .describe("Text to search for (for containingText template)"),
        listIdentifier: z
          .string()
          .optional()
          .describe("Mailing list identifier (for mailingList template)"),
        sizeInBytes: coerceInt({ min: 0 })
          .optional()
          .describe("Size threshold in bytes (for largeEmails template)"),
        labelIds: coerceArray(GmailIdSchema).optional().describe("Label IDs to apply"),
        archive: z.boolean().optional().describe("Whether to archive (skip inbox)"),
        markAsRead: z.boolean().optional().describe("Whether to mark as read"),
        markImportant: z.boolean().optional().describe("Whether to mark as important"),
      })
      .describe("Template-specific parameters"),
  })
  .describe("Creates a filter using a pre-defined template");

export const DownloadAttachmentSchema = z.object({
  messageId: GmailIdSchema.describe("ID of the email message containing the attachment"),
  attachmentId: GmailIdSchema.describe("ID of the attachment to download"),
  filename: z
    .string()
    .optional()
    .describe("Filename to save the attachment as (if not provided, uses original filename)"),
  savePath: z
    .string()
    .optional()
    .describe("Directory path to save the attachment (defaults to current directory)"),
});

export const DownloadEmailSchema = z.object({
  messageId: GmailIdSchema.describe("ID of the email message to download"),
  savePath: z.string().describe("Directory path to save the email file"),
  format: z
    .enum(["json", "eml", "txt", "html"])
    .optional()
    .default("json")
    .describe(
      "Output format: json (structured data), eml (raw RFC822), txt (plain text), html (formatted HTML)",
    ),
});

export const ModifyThreadSchema = z.object({
  threadId: GmailIdSchema.describe("ID of the Gmail thread to modify"),
  addLabelIds: coerceArray(GmailIdSchema)
    .optional()
    .describe("List of label IDs to add to all messages in the thread"),
  removeLabelIds: coerceArray(GmailIdSchema)
    .optional()
    .describe("List of label IDs to remove from all messages in the thread"),
});

// Thread-level schemas
export const GetThreadSchema = z.object({
  threadId: GmailIdSchema.describe("ID of the email thread to retrieve"),
  format: z
    .enum(["full", "metadata", "minimal"])
    .optional()
    .default("full")
    .describe("Format of the email messages returned (default: full)"),
});

export const ListInboxThreadsSchema = z.object({
  query: z
    .string()
    .optional()
    .default("in:inbox")
    .describe("Gmail search query (default: 'in:inbox')"),
  maxResults: coerceInt({ min: 1, max: 500 })
    .optional()
    .default(50)
    .describe("Maximum number of threads to return (1-500, default 50)"),
});

export const GetInboxWithThreadsSchema = z
  .object({
    query: z
      .string()
      .optional()
      .default("in:inbox")
      .describe("Gmail search query (default: 'in:inbox')"),
    maxResults: coerceInt({ min: 1, max: 500 })
      .optional()
      .default(50)
      .describe(
        "Maximum number of threads to return. Up to 500 when expandThreads=false (lightweight summary); capped at 100 when expandThreads=true because each thread triggers a full-body fetch.",
      ),
    expandThreads: z
      .boolean()
      .optional()
      .default(true)
      .describe("Whether to fetch full thread content for each thread (default: true)"),
  })
  .refine((args) => !args.expandThreads || args.maxResults <= 100, {
    message:
      "maxResults cannot exceed 100 when expandThreads is true (body fetches). Set expandThreads=false to request up to 500.",
    path: ["maxResults"],
  });

// Recipient pairing gate schema — opt-in allowlist ops (add/remove/list).
// Gate itself is enforced in handleEmailAction + reply_all when
// GMAIL_MCP_RECIPIENT_PAIRING=true. See src/recipient-pairing.ts.
//
// `email` is shape-checked at the schema layer with the same RFC 5322
// parser (`email-addresses.parseOneAddress`) used by send/reply/draft —
// so a malformed address is rejected pre-dispatch instead of bubbling
// out of `addPairedAddress` at runtime, and the agent sees a Zod
// validation error rather than a generic Error.
export const PairRecipientSchema = z.object({
  action: z
    .enum(["add", "remove", "list"])
    .describe("Operation on the paired-recipients allowlist"),
  email: z
    .string()
    .max(512)
    .refine((addr) => {
      // `parseOneAddress` may return a `group` node (RFC 5322 syntax
      // `"team: a@b, c@d;"`) — a group parses fine but is NOT a single
      // mailbox. Accepting one here would let `team: …;` past the
      // pairing allowlist while none of the contained mailboxes have
      // been individually approved. Restrict to `type === "mailbox"`.
      const parsed = emailAddresses.parseOneAddress(addr);
      return parsed !== null && parsed.type === "mailbox";
    }, "Must be a parseable RFC 5322 mailbox address (e.g. user@example.com — RFC 5322 groups are rejected).")
    .optional()
    .describe("Email address to add or remove. Required when action is add or remove."),
});

// Drafts CRUD — extends `draft_email` (create) with the rest of the
// surface: list / get / update / delete / send. Each operation maps
// 1:1 to a `gmail.users.drafts.*` endpoint. Scopes mirror the
// underlying API: read = readonly|modify|compose, write = modify|compose,
// send = modify|send.

export const ListDraftsSchema = z.object({
  maxResults: coerceInt({ min: 1, max: 500 })
    .optional()
    .default(20)
    .describe(
      "Maximum number of drafts to return per page (1-500). Default 20. Mirrors `users.drafts.list` upper bound.",
    ),
  pageToken: z
    .string()
    .max(2048)
    .optional()
    .describe(
      "Pagination token from a previous `list_drafts` call. Pass to fetch the next page; absent on the first page.",
    ),
  q: z
    .string()
    .max(2048)
    .optional()
    .describe(
      "Optional Gmail search query (same syntax as `search_emails`, e.g. `from:alice@example.com subject:invoice`) to filter the drafts returned.",
    ),
  includeSpamTrash: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include drafts living under the SPAM or TRASH labels. Default false."),
});

export const GetDraftSchema = z.object({
  id: GmailIdSchema.describe("Draft ID to fetch (from `list_drafts`)"),
  format: z
    .enum(["full", "metadata", "minimal", "raw"])
    .optional()
    .default("full")
    .describe(
      "Response shape: 'full' (default — headers + body + attachment list), 'metadata' (headers only, no body), 'minimal' (id + threadId + labelIds only), 'raw' (RFC 5322-encoded raw message).",
    ),
});

// `update_draft` shape mirrors `SendEmailSchema` + a draft `id`.
// Replacing a draft fully overwrites its message contents — there
// is no patch endpoint on Gmail's drafts API. The shape stays in
// lock-step with `SendEmailSchema` so an agent that already knows
// how to compose a message can update a draft without learning a
// second schema.
export const UpdateDraftSchema = z.object({
  id: GmailIdSchema.describe("Draft ID to update (from `list_drafts`)"),
  to: coerceArray(z.string()).describe("List of recipient email addresses"),
  subject: z.string().describe("Email subject"),
  body: z
    .string()
    .describe("Email body content (used for text/plain or when htmlBody not provided)"),
  from: z
    .string()
    .optional()
    .describe(
      "Sender email address (must be a configured send-as alias in Gmail settings). Defaults to account's default send-as address if not specified.",
    ),
  htmlBody: z.string().optional().describe("HTML version of the email body"),
  mimeType: z
    .enum(["text/plain", "text/html", "multipart/alternative"])
    .optional()
    .default("text/plain")
    .describe("Email content type"),
  cc: coerceArray(z.string()).optional().describe("List of CC recipients"),
  bcc: coerceArray(z.string()).optional().describe("List of BCC recipients"),
  threadId: GmailIdSchema.optional().describe("Thread ID to associate the updated draft with"),
  inReplyTo: z
    .string()
    .max(998)
    .optional()
    .describe("RFC 5322 Message-ID being replied to (e.g. <abc@host>, max 998 chars)"),
  attachments: coerceArray(FilePathSchema)
    .optional()
    .describe("List of file paths to attach to the draft"),
});

export const DeleteDraftSchema = z.object({
  id: GmailIdSchema.describe(
    "Draft ID to permanently delete. **Irreversible** — there is no Gmail-side trash for drafts.",
  ),
});

export const SendDraftSchema = z.object({
  id: GmailIdSchema.describe(
    "Draft ID to convert into a sent message. The draft is sent verbatim — no further composition step.",
  ),
});

// Reply All schema - fetches original email and builds recipient list automatically
export const ReplyAllSchema = z.object({
  messageId: GmailIdSchema.describe("ID of the email message to reply to"),
  body: z
    .string()
    .describe("Reply body content (used for text/plain or when htmlBody not provided)"),
  htmlBody: z.string().optional().describe("HTML version of the reply body"),
  mimeType: z
    .enum(["text/plain", "text/html", "multipart/alternative"])
    .optional()
    .default("text/plain")
    .describe("Email content type"),
  attachments: coerceArray(FilePathSchema)
    .optional()
    .describe("List of file paths to attach to the reply"),
});

// Tool definition type
export interface ToolAnnotations {
  title: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  // zod-to-json-schema@3's public signature widens to `z.ZodType<any>`;
  // using a tighter generic here causes a structural mismatch at the
  // consumer call site. The `any` is fenced inside ToolDefinition only.
  schema: z.ZodType<unknown>;
  scopes: string[]; // Any of these scopes grants access
  annotations: ToolAnnotations;
}

// Tool registry with scope requirements
export const toolDefinitions: ToolDefinition[] = [
  // Read-only email operations
  {
    name: "read_email",
    description: [
      "Retrieve the full content of one Gmail message by `messageId`, including headers, body, and attachment metadata.",
      "",
      "USE WHEN: a `messageId` is already known (typically from `search_emails`, `list_inbox_threads`, or a webhook).",
      "",
      "DO NOT USE: to enumerate the inbox (use `search_emails` or `list_inbox_threads`). For an entire thread use `get_thread`. To save the message to a file without filling context, use `download_email`.",
    ].join("\n"),
    schema: ReadEmailSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Read Email", readOnlyHint: true },
  },
  {
    name: "search_emails",
    description: [
      "Search for messages using Gmail's native query syntax (e.g. `from:foo@bar.com after:2024/01/01 has:attachment`).",
      "",
      "USE WHEN: locating messages by sender, date, subject, label, or any Gmail operator. Returns a flat list of matches across the whole mailbox (not thread-grouped).",
      "",
      "DO NOT USE: to read one specific message whose ID is already known (use `read_email`). For thread-grouped browsing, use `list_inbox_threads`.",
    ].join("\n"),
    schema: SearchEmailsSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Search Emails", readOnlyHint: true },
  },
  {
    name: "download_attachment",
    description: [
      "Download a Gmail attachment to a path on the host filesystem.",
      "",
      "USE WHEN: persisting an attachment locally for archival, OCR, or downstream processing. The filename is sanitized server-side (path-traversal blocked, control chars stripped).",
      "",
      "DO NOT USE: to inspect an attachment's metadata only — use `read_email` (returns attachment list with size + MIME type). The destination path must be writable by the MCP host process.",
    ].join("\n"),
    schema: DownloadAttachmentSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Download Attachment", readOnlyHint: true },
  },

  // Thread-level operations
  {
    name: "get_thread",
    description: [
      "Retrieve all messages in a thread in one call, ordered chronologically (oldest first) with full content, headers, labels, and attachment metadata.",
      "",
      "USE WHEN: reading a full conversation, building a reply that needs context, or analysing back-and-forth across multiple messages.",
      "",
      "DO NOT USE: to read one specific message (use `read_email`). To browse multiple threads at once with bodies expanded, use `get_inbox_with_threads`.",
    ].join("\n"),
    schema: GetThreadSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Get Thread", readOnlyHint: true },
  },
  {
    name: "list_inbox_threads",
    description: [
      "List email threads matching a Gmail query (default: inbox). Returns a thread-level view with snippet, message count, and latest message metadata.",
      "",
      "USE WHEN: browsing the inbox by conversation rather than by individual messages. Cheaper than fetching message bodies — useful for triage or finding a thread ID.",
      "",
      "DO NOT USE: to read individual messages (use `read_email`). For one specific thread you already know, use `get_thread`. To browse with bodies expanded, use `get_inbox_with_threads`.",
    ].join("\n"),
    schema: ListInboxThreadsSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "List Inbox Threads", readOnlyHint: true },
  },
  {
    name: "get_inbox_with_threads",
    description: [
      "List threads and optionally expand each with full message content in a single call.",
      "",
      "USE WHEN: bulk-reading a slice of the inbox (last N threads, daily digest). Saves a round-trip per thread compared to `list_inbox_threads` + `get_thread` × N.",
      "",
      "DO NOT USE: when only one thread is needed (use `get_thread`). For just thread metadata without bodies, use `list_inbox_threads` (cheaper). Returned payload can be large — bound `maxResults` to control context usage.",
    ].join("\n"),
    schema: GetInboxWithThreadsSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Get Inbox with Threads", readOnlyHint: true },
  },
  {
    name: "modify_thread",
    description: [
      "Modify labels on ALL messages in a thread atomically (Gmail `threads.modify` endpoint).",
      "",
      'USE WHEN: archiving a whole conversation (`removeLabelIds: ["INBOX"]`), marking a thread as read (`removeLabelIds: ["UNREAD"]`), applying a project label across all messages, etc. Atomic — either every message updates or none.',
      "",
      "DO NOT USE: to modify one specific message in a thread (use `modify_email`). To purge a thread, modify-to-trash + then `batch_delete_emails`. Filters are not retroactive — apply labels via this tool, not by creating a filter.",
      "",
      "SIDE EFFECTS: rewrites the label set on every message in the thread. **Reversible** — re-issue with the inverse `addLabelIds` / `removeLabelIds`. Idempotent (calling twice is a no-op). Visible in Gmail UI immediately.",
    ].join("\n"),
    schema: ModifyThreadSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Modify Thread", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "download_email",
    description: [
      "Save one Gmail message to a file (json, eml, txt, or html).",
      "",
      "USE WHEN: persisting a message to disk for archival, evidence, or downstream processing. Returns metadata + the path written — bodies are NOT loaded into the LLM context, so this is the right choice for large messages.",
      "",
      "DO NOT USE: to read content into the LLM (use `read_email` or `get_thread`). The destination path must be writable by the MCP host process; filename traversal is blocked.",
    ].join("\n"),
    schema: DownloadEmailSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Download Email", readOnlyHint: true },
  },

  // Email write operations
  {
    name: "send_email",
    description: [
      "Send a new email from the authenticated Gmail account. **The email is delivered to the recipient(s) immediately.**",
      "",
      "USE WHEN: composing and dispatching a fresh outbound email. ALWAYS confirm recipients, subject, body, and attachments with the user before calling — there is no draft step.",
      "",
      "DO NOT USE: to reply to an existing thread (use `reply_all` for full-list replies; threading headers are set automatically). To stage a draft for later review, use `draft_email`. To send to a recipient that has not been pre-approved when `GMAIL_MCP_RECIPIENT_PAIRING` is enabled, the call will be rejected — pair the address first via `pair_recipient`.",
      "",
      "SIDE EFFECTS: real email leaves the account, recorded in the `Sent` mailbox, billed against the account's daily send quota. Audit log entry on the MCP host.",
    ].join("\n"),
    schema: SendEmailSchema,
    scopes: ["gmail.modify", "gmail.compose", "gmail.send"],
    annotations: { title: "Send Email", destructiveHint: false },
  },
  {
    name: "pair_recipient",
    description: [
      "Manage the paired-recipient allowlist (`~/.gmail-mcp/paired.json`). Actions: `add`, `remove`, `list`. Only effective when `GMAIL_MCP_RECIPIENT_PAIRING` is enabled.",
      "",
      "USE WHEN: pre-approving a To/Cc/Bcc address so future `send_email` / `reply_all` / `draft_email` calls go through without per-call confirmation. Designed to cap the blast radius of a prompt-injected send.",
      "",
      "DO NOT USE: with the gate disabled — pairing has no effect there. ALWAYS confirm with the user before adding an address: paired addresses can be emailed without further approval.",
      "",
      "SIDE EFFECTS: writes to `~/.gmail-mcp/paired.json` on the MCP host. Persistent across runs. Idempotent on `add` (re-adding the same address is a no-op).",
    ].join("\n"),
    schema: PairRecipientSchema,
    // Exposed wherever the send surface is; an operator with a
    // readonly-only token has nothing to pair.
    scopes: ["gmail.modify", "gmail.compose", "gmail.send", "mail.google.com"],
    annotations: { title: "Pair Recipient", destructiveHint: false, idempotentHint: true },
  },
  {
    name: "draft_email",
    description: [
      "Save a new email as a draft in the Gmail Drafts folder. **No mail is sent.**",
      "",
      "USE WHEN: composing an email that the human should review and send manually from the Gmail UI. Useful for high-stakes outbound where the human-in-the-loop is required.",
      "",
      "DO NOT USE: to send immediately (use `send_email`). The draft remains visible in the user's Gmail Drafts folder until they send or delete it. To enumerate existing drafts, use `list_drafts`. To inspect / mutate / delete an existing draft, use `get_draft` / `update_draft` / `delete_draft`. To send an existing draft, use `send_draft`.",
      "",
      "SIDE EFFECTS: writes a draft to Gmail. Persistent. Counts toward the account's draft quota (rare to hit). Subject to the same recipient-pairing gate as `send_email` when enabled.",
    ].join("\n"),
    schema: SendEmailSchema,
    scopes: ["gmail.modify", "gmail.compose"],
    annotations: { title: "Draft Email", destructiveHint: false },
  },
  {
    name: "list_drafts",
    description: [
      "List the drafts in the authenticated Gmail account, paginated.",
      "",
      "USE WHEN: enumerating existing drafts before reading / updating / deleting / sending one. Returns a flat list with `id`, `messageId`, `threadId`, plus a `nextPageToken` when more results exist. Pass an optional `q` to filter (same syntax as `search_emails`).",
      "",
      "DO NOT USE: to inspect a single draft whose ID is known (use `get_draft`). The list response is light — call `get_draft` to materialise the headers and body of any specific draft.",
    ].join("\n"),
    schema: ListDraftsSchema,
    scopes: ["gmail.readonly", "gmail.modify", "gmail.compose"],
    annotations: { title: "List Drafts", readOnlyHint: true },
  },
  {
    name: "get_draft",
    description: [
      "Retrieve one Gmail draft by `id`, including headers, body, and attachment metadata.",
      "",
      "USE WHEN: an `id` is already known (typically from `list_drafts`). Default `format: 'full'` returns the materialised headers + body. Pass `format: 'metadata'` for headers only, or `format: 'raw'` for the RFC 5322-encoded payload (downloadable / re-uploadable verbatim).",
      "",
      "DO NOT USE: to enumerate drafts (use `list_drafts`).",
    ].join("\n"),
    schema: GetDraftSchema,
    scopes: ["gmail.readonly", "gmail.modify", "gmail.compose"],
    annotations: { title: "Get Draft", readOnlyHint: true },
  },
  {
    name: "update_draft",
    description: [
      "Replace an existing draft's message contents. **No mail is sent.**",
      "",
      "USE WHEN: amending a draft that has already been created (typically via `draft_email` or via the Gmail UI). The replacement is a FULL overwrite — Gmail's API has no patch endpoint for drafts. The `id` of the draft is preserved; the underlying message gets a new `messageId` after the update.",
      "",
      "DO NOT USE: to send the draft (use `send_draft`). To create a new draft, use `draft_email`.",
      "",
      "SIDE EFFECTS: rewrites the draft message in place. Subject to the same recipient-pairing gate as `send_email` when enabled. Idempotent given identical inputs.",
    ].join("\n"),
    schema: UpdateDraftSchema,
    // CR finding (PR #100): drop `gmail.compose` from update_draft.
    // The PR's intent matrix gates update / delete behind the modify
    // scope. Allowing compose-only tokens to update advertises the
    // tool to a strictly narrower-than-modify identity, which
    // contradicts the documented mapping in `docs/ROADMAP.md` and
    // the README catalog. Gmail's API would accept `gmail.compose`
    // for `users.drafts.update` upstream, but our tool gating is
    // additive on top of that — pinning to `modify` keeps the
    // "destructive write that must hit the modify capability" floor
    // intact.
    scopes: ["gmail.modify"],
    annotations: { title: "Update Draft", destructiveHint: false, idempotentHint: true },
  },
  {
    name: "delete_draft",
    description: [
      "**PERMANENTLY DELETE** a Gmail draft by `id`. The draft is removed immediately — Gmail does NOT trash a deleted draft; there is no recovery.",
      "",
      "USE WHEN: removing a draft that should never be sent. ALWAYS confirm with the user before calling — Gmail offers no undo for draft deletion.",
      "",
      "DO NOT USE: to send the draft (use `send_draft`). To inspect the draft before deletion, use `get_draft`.",
      "",
      "SIDE EFFECTS: irrevocable removal of the draft. Quota slot recovered.",
    ].join("\n"),
    schema: DeleteDraftSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Delete Draft", destructiveHint: true },
  },
  {
    name: "send_draft",
    description: [
      "Send an existing Gmail draft by `id`. **The email is delivered to the recipients immediately.**",
      "",
      "USE WHEN: dispatching a draft that has already been composed and (typically) reviewed by the human. The draft is sent verbatim — there is no further composition step. ALWAYS confirm the recipient list, subject, and body with the user before calling (`get_draft` is the inspection tool).",
      "",
      "DO NOT USE: to send a brand-new email without staging it as a draft first (use `send_email`). To delete a draft instead of sending, use `delete_draft`.",
      "",
      "SIDE EFFECTS: real email leaves the account, recorded in the `Sent` mailbox, billed against the account's daily send quota. The draft is consumed (its slot is freed). Subject to the same recipient-pairing gate as `send_email` when enabled (gate runs against the recipient list embedded in the draft).",
    ].join("\n"),
    schema: SendDraftSchema,
    scopes: ["gmail.modify", "gmail.compose", "gmail.send"],
    annotations: { title: "Send Draft", destructiveHint: false },
  },
  {
    name: "modify_email",
    description: [
      "Modify labels on one specific message (move between folders, mark read/unread, archive, trash).",
      "",
      'USE WHEN: changing the label set on a single message — archiving (`removeLabelIds: ["INBOX"]`), trashing (`addLabelIds: ["TRASH"]`), marking read, etc.',
      "",
      'DO NOT USE: to modify the entire thread (use `modify_thread` for atomic update). To delete permanently, use `delete_email` (`addLabelIds: ["TRASH"]` only moves to trash; messages stay there for 30 days). For multiple messages, use `batch_modify_emails`.',
      "",
      "SIDE EFFECTS: rewrites the label set on the message. **Reversible** by inverting `addLabelIds` / `removeLabelIds`. Idempotent. Visible in Gmail UI immediately.",
    ].join("\n"),
    schema: ModifyEmailSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Modify Email", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "delete_email",
    description: [
      "**PERMANENTLY DELETE** one Gmail message — bypasses Trash, no recovery.",
      "",
      "USE WHEN: purging a message that must not remain on Google's servers (compliance, data-leak response). ALWAYS confirm with the user before calling — Gmail offers no undo and does not send the message to Trash.",
      "",
      'DO NOT USE: for routine archival (use `modify_email` with `removeLabelIds: ["INBOX"]`). To move to Trash with the standard 30-day grace period, use `modify_email` with `addLabelIds: ["TRASH"]`. For multiple messages, use `batch_delete_emails`.',
      "",
      "SIDE EFFECTS: **irrecoverable deletion** server-side. Requires the full `mail.google.com` scope (the `gmail.modify` scope is rejected with HTTP 403 for this endpoint).",
    ].join("\n"),
    schema: DeleteEmailSchema,
    // Permanent delete requires the full mail.google.com scope.
    // gmail.modify is enough for trashing (modify_email) but the
    // users.messages.delete endpoint specifically rejects it with
    // HTTP 403 "Insufficient Permission".
    scopes: ["mail.google.com"],
    annotations: { title: "Delete Email", destructiveHint: true },
  },
  {
    name: "batch_modify_emails",
    description: [
      "Modify labels on a list of messages in chunked batches (Gmail's `batchModify` endpoint).",
      "",
      "USE WHEN: applying the same label change to many messages at once — bulk-archive 200 newsletters, mark a search-result set as read, label a project's worth of emails. Cheaper than calling `modify_email` N times.",
      "",
      "DO NOT USE: for one or two messages (use `modify_email`). All messages get the same `addLabelIds` / `removeLabelIds` — there is no per-message variation. The MCP chunks at Gmail's 1000-message limit; partial-batch failures may leave the operation half-applied.",
      "",
      "SIDE EFFECTS: rewrites labels across many messages. **Reversible** by re-running with the inverse. Idempotent. Audit log entry logs the message-ID list (truncated for readability).",
    ].join("\n"),
    schema: BatchModifyEmailsSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Batch Modify Emails", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "batch_delete_emails",
    description: [
      "**PERMANENTLY DELETE** a list of messages in chunked batches (Gmail's `batchDelete` endpoint). Bypasses Trash, no recovery.",
      "",
      "USE WHEN: a compliance event or data-leak response requires purging many specific messages at once. ALWAYS confirm the message-ID list with the user — Gmail offers no undo at any point.",
      "",
      'DO NOT USE: to bulk-archive (use `batch_modify_emails` with `addLabelIds: ["TRASH"]`). For one message, use `delete_email`. The MCP chunks at Gmail\'s 1000-message limit; partial-batch failures may leave some deleted, some intact.',
      "",
      "SIDE EFFECTS: **irrecoverable deletion** of every listed message. Requires the full `mail.google.com` scope. Audit log entry logs the message-ID list (truncated for readability).",
    ].join("\n"),
    schema: BatchDeleteEmailsSchema,
    // Same scope requirement as delete_email — see comment above.
    scopes: ["mail.google.com"],
    annotations: { title: "Batch Delete Emails", destructiveHint: true },
  },

  // Label operations
  {
    name: "list_email_labels",
    description: [
      "List all Gmail labels (system + user-defined) available on the authenticated account.",
      "",
      "USE WHEN: discovering valid label IDs/names before calling `modify_email`, `modify_thread`, or any filter that targets labels. Also useful to confirm a label exists before `create_label`.",
      "",
      "DO NOT USE: to fetch one specific label by name — there is no get-single-label tool; call this and filter client-side.",
    ].join("\n"),
    schema: ListEmailLabelsSchema,
    scopes: ["gmail.readonly", "gmail.modify", "gmail.labels"],
    annotations: { title: "List Email Labels", readOnlyHint: true },
  },
  {
    name: "create_label",
    description: [
      "Create a new user label in the authenticated Gmail account.",
      "",
      "USE WHEN: setting up a new label for organisation (project name, status flag, custom inbox). The returned label `id` is what `modify_email` and `modify_thread` accept in `addLabelIds`.",
      "",
      "DO NOT USE: to create a label that may already exist — Gmail returns 409 on duplicate names. Use `get_or_create_label` for the idempotent variant.",
      "",
      "SIDE EFFECTS: writes a new label to the account. Persistent and visible in the Gmail UI immediately.",
    ].join("\n"),
    schema: CreateLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Create Label", destructiveHint: false },
  },
  {
    name: "update_label",
    description: [
      "Update an existing Gmail label (rename, change visibility, change colour).",
      "",
      "USE WHEN: renaming a label across the account or amending its visibility / colour. Existing messages keep the same label ID — no message reprocessing.",
      "",
      "DO NOT USE: to delete a label (use `delete_label`). Renaming a system label (`INBOX`, `SENT`, `DRAFT`, etc.) is rejected by Gmail.",
      "",
      "SIDE EFFECTS: overwrites the label record. The new name appears immediately in the Gmail UI on every message that had it. **Reversible** by calling again with the previous values. Idempotent.",
    ].join("\n"),
    schema: UpdateLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Update Label", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "delete_label",
    description: [
      "**Permanently delete** a Gmail label.",
      "",
      "USE WHEN: removing an obsolete label. Messages tagged with the label keep their other labels — only this association is removed. ALWAYS confirm with the user before calling.",
      "",
      "DO NOT USE: to rename a label (use `update_label`). System labels (`INBOX`, `SENT`, `DRAFT`, etc.) cannot be deleted — Gmail rejects the request.",
      "",
      "SIDE EFFECTS: the label disappears from the account. Messages that had it lose this association — re-tagging requires the original messages to be retrieved and re-modified individually. Not recoverable from API.",
    ].join("\n"),
    schema: DeleteLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Delete Label", destructiveHint: true },
  },
  {
    name: "get_or_create_label",
    description: [
      "Idempotent label lookup-or-create: returns the label if it already exists, otherwise creates it.",
      "",
      "USE WHEN: ensuring a label is available before `modify_email` / `modify_thread`, without caring whether it pre-existed. Safe to call repeatedly.",
      "",
      "DO NOT USE: to enumerate labels (use `list_email_labels`). Equivalent of `create_label` if you specifically want to fail on duplicates.",
      "",
      "SIDE EFFECTS: may create a new label (persistent) on first call; subsequent calls with the same name are no-ops at the API level.",
    ].join("\n"),
    schema: GetOrCreateLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Get or Create Label", destructiveHint: false, idempotentHint: true },
  },

  // Filter operations (require settings scope)
  {
    name: "list_filters",
    description: [
      "List all Gmail filters configured on the authenticated account.",
      "",
      "USE WHEN: auditing filter rules, finding a filter ID before update/delete, or confirming a rule already exists before creating a duplicate.",
      "",
      "DO NOT USE: to fetch one specific filter whose ID is known (use `get_filter`).",
    ].join("\n"),
    schema: ListFiltersSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "List Filters", readOnlyHint: true },
  },
  {
    name: "get_filter",
    description: [
      "Retrieve the full detail of one Gmail filter by ID (criteria + actions).",
      "",
      "USE WHEN: inspecting a specific filter's rules whose ID is already known (typically from `list_filters`).",
      "",
      "DO NOT USE: to enumerate filters (use `list_filters`).",
    ].join("\n"),
    schema: GetFilterSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Get Filter", readOnlyHint: true },
  },
  {
    name: "create_filter",
    description: [
      "Create a new Gmail filter from custom criteria + actions (e.g. `from:newsletter@x.com` → archive + apply label).",
      "",
      "USE WHEN: automating inbox routing for a specific pattern not covered by Gmail's built-in templates. The filter applies to FUTURE messages only — past matching messages are not retroactively processed.",
      "",
      "DO NOT USE: for common patterns (newsletter routing, vendor invoices, etc.) — `create_filter_from_template` covers those with safer defaults. Filters are not idempotent — calling twice creates two filters firing duplicate actions.",
      "",
      "SIDE EFFECTS: writes a new filter rule on Gmail's side. Persistent. Affects every future incoming message that matches the criteria. The optional `action.forward` field installs a persistent forwarding rule and is therefore gated by the same recipient-pairing allowlist as `send_email` / `reply_all` / `draft_email` when `GMAIL_MCP_RECIPIENT_PAIRING=true` — pair the address via `pair_recipient` first. Requires `gmail.settings.basic` scope.",
    ].join("\n"),
    schema: CreateFilterSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Create Filter", destructiveHint: true },
  },
  {
    name: "delete_filter",
    description: [
      "**Permanently delete** a Gmail filter. Future incoming messages stop being processed by the rule.",
      "",
      "USE WHEN: removing an obsolete or wrongly-configured filter. ALWAYS confirm with the user — there is no undo, and any incoming-mail automation that depended on the filter stops working.",
      "",
      "DO NOT USE: to temporarily disable a filter — Gmail offers no pause-state, only delete / recreate. To inspect first, fetch via `get_filter`.",
      "",
      "SIDE EFFECTS: filter rule is removed server-side. Past messages already processed by the filter are NOT reverted — only future messages are affected. Not recoverable from API. Requires `gmail.settings.basic` scope.",
    ].join("\n"),
    schema: DeleteFilterSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Delete Filter", destructiveHint: true },
  },
  {
    name: "create_filter_from_template",
    description: [
      "Create a filter from a pre-defined template (`fromSender`, `withSubject`, `withAttachments`, `largeEmails`, `containingText`, `mailingList`). Safer than free-form filter creation — templates are vetted.",
      "",
      "USE WHEN: setting up routing for a common pattern. Templates encode tested combinations of criteria + actions, sparing the agent the burden of crafting a correct query.",
      "",
      "DO NOT USE: for one-off custom rules (use `create_filter`).",
      "",
      "SIDE EFFECTS: same as `create_filter` — writes a persistent filter rule, applies to future messages only. Requires `gmail.settings.basic` scope.",
    ].join("\n"),
    schema: CreateFilterFromTemplateSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Create Filter from Template", destructiveHint: false },
  },

  // Reply-all operation
  {
    name: "reply_all",
    description: [
      "Reply to a thread, addressing every original recipient (To + CC). The MCP fetches the source message, builds the recipient list, and sets `In-Reply-To` / `References` headers automatically. **The reply is sent immediately.**",
      "",
      "USE WHEN: replying to a multi-party thread where every original recipient should receive the response. ALWAYS confirm the recipient list with the user before calling — `reply_all` can broadcast to a much wider audience than expected.",
      "",
      "DO NOT USE: when the user only wants to reply to the sender (no first-class `reply_to_email` tool exists yet — see ROADMAP; for now, use `send_email` with manual `In-Reply-To` headers). To stage a draft for review, use `draft_email`.",
      "",
      "SIDE EFFECTS: real email leaves the account, recorded in the `Sent` mailbox, billed against daily send quota. Subject to the same `GMAIL_MCP_RECIPIENT_PAIRING` gate as `send_email`.",
    ].join("\n"),
    schema: ReplyAllSchema,
    scopes: ["gmail.modify", "gmail.compose", "gmail.send"],
    annotations: { title: "Reply All", destructiveHint: false },
  },
];

// Convert tool definitions to MCP tool format. Uses Zod v4's native
// `z.toJSONSchema()` (draft 2020-12). The external `zod-to-json-schema@3`
// library is incompatible with Zod v4's ZodType shape and silently emits
// `{"$schema": "..."}` with no `type`/`properties`, which fails MCP
// Inspector validation (the spec requires `inputSchema.type = "object"`).
export function toMcpTools(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.schema),
    annotations: tool.annotations,
  }));
}

// Get a tool definition by name
export function getToolByName(name: string): ToolDefinition | undefined {
  return toolDefinitions.find((t) => t.name === name);
}
