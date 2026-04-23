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

// Schema definitions
export const SendEmailSchema = z.object({
  to: z.array(z.string()).describe("List of recipient email addresses"),
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
  cc: z.array(z.string()).optional().describe("List of CC recipients"),
  bcc: z.array(z.string()).optional().describe("List of BCC recipients"),
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
  attachments: z.array(z.string()).optional().describe("List of file paths to attach to the email"),
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
  maxBodyLength: z.coerce
    .number()
    .int()
    .min(0)
    .max(1_048_576)
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
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Maximum number of results to return (1-500, default 10)"),
});

export const ModifyEmailSchema = z.object({
  messageId: GmailIdSchema.describe("ID of the email message to modify"),
  labelIds: z.array(GmailIdSchema).optional().describe("List of label IDs to apply"),
  addLabelIds: z
    .array(GmailIdSchema)
    .optional()
    .describe("List of label IDs to add to the message"),
  removeLabelIds: z
    .array(GmailIdSchema)
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
  messageIds: z
    .array(GmailIdSchema)
    .max(1000)
    .describe("List of message IDs to modify (max 1000 per call)"),
  addLabelIds: z
    .array(GmailIdSchema)
    .optional()
    .describe("List of label IDs to add to all messages"),
  removeLabelIds: z
    .array(GmailIdSchema)
    .optional()
    .describe("List of label IDs to remove from all messages"),
  batchSize: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(50)
    .describe("Messages per batch (1-100, default 50)"),
});

export const BatchDeleteEmailsSchema = z.object({
  messageIds: z
    .array(GmailIdSchema)
    .max(1000)
    .describe("List of message IDs to delete (max 1000 per call)"),
  batchSize: z
    .number()
    .int()
    .min(1)
    .max(100)
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
        size: z.number().optional().describe("Email size in bytes"),
        sizeComparison: z
          .enum(["unspecified", "smaller", "larger"])
          .optional()
          .describe("Size comparison operator"),
      })
      .describe("Criteria for matching emails"),
    action: z
      .object({
        addLabelIds: z
          .array(GmailIdSchema)
          .optional()
          .describe("Label IDs to add to matching emails"),
        removeLabelIds: z
          .array(GmailIdSchema)
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
        sizeInBytes: z
          .number()
          .optional()
          .describe("Size threshold in bytes (for largeEmails template)"),
        labelIds: z.array(GmailIdSchema).optional().describe("Label IDs to apply"),
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
  addLabelIds: z
    .array(GmailIdSchema)
    .optional()
    .describe("List of label IDs to add to all messages in the thread"),
  removeLabelIds: z
    .array(GmailIdSchema)
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
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(500)
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
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(500)
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
  attachments: z.array(z.string()).optional().describe("List of file paths to attach to the reply"),
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
    description: "Retrieves the content of a specific email",
    schema: ReadEmailSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Read Email", readOnlyHint: true },
  },
  {
    name: "search_emails",
    description: "Searches for emails using Gmail search syntax",
    schema: SearchEmailsSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Search Emails", readOnlyHint: true },
  },
  {
    name: "download_attachment",
    description: "Downloads an email attachment to a specified location",
    schema: DownloadAttachmentSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Download Attachment", readOnlyHint: true },
  },

  // Thread-level operations
  {
    name: "get_thread",
    description:
      "Retrieves all messages in an email thread in one call. Returns messages ordered chronologically (oldest first) with full content, headers, labels, and attachment metadata.",
    schema: GetThreadSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Get Thread", readOnlyHint: true },
  },
  {
    name: "list_inbox_threads",
    description:
      "Lists email threads matching a query (default: inbox). Returns thread-level view with snippet, message count, and latest message metadata.",
    schema: ListInboxThreadsSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "List Inbox Threads", readOnlyHint: true },
  },
  {
    name: "get_inbox_with_threads",
    description:
      "Convenience tool that lists threads and optionally expands each with full message content. One call returns the full inbox with complete thread bodies.",
    schema: GetInboxWithThreadsSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Get Inbox with Threads", readOnlyHint: true },
  },
  {
    name: "modify_thread",
    description:
      "Modifies labels on ALL messages in a thread atomically using the Gmail threads.modify endpoint. Use this instead of modify_email when you want to apply label changes (e.g., archive, mark as read) to an entire thread at once.",
    schema: ModifyThreadSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Modify Thread", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "download_email",
    description:
      "Downloads an email to a file in various formats (json, eml, txt, html). Returns metadata only - useful for saving emails without consuming context.",
    schema: DownloadEmailSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Download Email", readOnlyHint: true },
  },

  // Email write operations
  {
    name: "send_email",
    description: "Sends a new email",
    schema: SendEmailSchema,
    scopes: ["gmail.modify", "gmail.compose", "gmail.send"],
    annotations: { title: "Send Email", destructiveHint: false },
  },
  {
    name: "draft_email",
    description: "Draft a new email",
    schema: SendEmailSchema,
    scopes: ["gmail.modify", "gmail.compose"],
    annotations: { title: "Draft Email", destructiveHint: false },
  },
  {
    name: "modify_email",
    description: "Modifies email labels (move to different folders)",
    schema: ModifyEmailSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Modify Email", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "delete_email",
    description: "Permanently deletes an email",
    schema: DeleteEmailSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Delete Email", destructiveHint: true },
  },
  {
    name: "batch_modify_emails",
    description: "Modifies labels for multiple emails in batches",
    schema: BatchModifyEmailsSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Batch Modify Emails", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "batch_delete_emails",
    description: "Permanently deletes multiple emails in batches",
    schema: BatchDeleteEmailsSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Batch Delete Emails", destructiveHint: true },
  },

  // Label operations
  {
    name: "list_email_labels",
    description: "Retrieves all available Gmail labels",
    schema: ListEmailLabelsSchema,
    scopes: ["gmail.readonly", "gmail.modify", "gmail.labels"],
    annotations: { title: "List Email Labels", readOnlyHint: true },
  },
  {
    name: "create_label",
    description: "Creates a new Gmail label",
    schema: CreateLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Create Label", destructiveHint: false },
  },
  {
    name: "update_label",
    description: "Updates an existing Gmail label",
    schema: UpdateLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Update Label", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "delete_label",
    description: "Deletes a Gmail label",
    schema: DeleteLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Delete Label", destructiveHint: true },
  },
  {
    name: "get_or_create_label",
    description: "Gets an existing label by name or creates it if it doesn't exist",
    schema: GetOrCreateLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Get or Create Label", destructiveHint: false, idempotentHint: true },
  },

  // Filter operations (require settings scope)
  {
    name: "list_filters",
    description: "Retrieves all Gmail filters",
    schema: ListFiltersSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "List Filters", readOnlyHint: true },
  },
  {
    name: "get_filter",
    description: "Gets details of a specific Gmail filter",
    schema: GetFilterSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Get Filter", readOnlyHint: true },
  },
  {
    name: "create_filter",
    description: "Creates a new Gmail filter with custom criteria and actions",
    schema: CreateFilterSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Create Filter", destructiveHint: false },
  },
  {
    name: "delete_filter",
    description: "Deletes a Gmail filter",
    schema: DeleteFilterSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Delete Filter", destructiveHint: true },
  },
  {
    name: "create_filter_from_template",
    description: "Creates a filter using a pre-defined template for common scenarios",
    schema: CreateFilterFromTemplateSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Create Filter from Template", destructiveHint: false },
  },

  // Reply-all operation
  {
    name: "reply_all",
    description:
      "Replies to all recipients of an email. Automatically fetches the original email to build the recipient list (To, CC) and sets proper threading headers.",
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
