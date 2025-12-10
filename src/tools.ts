import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Schema definitions
export const SendEmailSchema = z.object({
  to: z.array(z.string()).describe("List of recipient email addresses"),
  subject: z.string().describe("Email subject"),
  body: z.string().describe("Email body content (used for text/plain or when htmlBody not provided)"),
  from: z.string().optional().describe("Sender email address (must be a configured send-as alias in Gmail settings). Defaults to account's default send-as address if not specified."),
  htmlBody: z.string().optional().describe("HTML version of the email body"),
  mimeType: z.enum(['text/plain', 'text/html', 'multipart/alternative']).optional().default('text/plain').describe("Email content type"),
  cc: z.array(z.string()).optional().describe("List of CC recipients"),
  bcc: z.array(z.string()).optional().describe("List of BCC recipients"),
  threadId: z.string().optional().describe("Thread ID to reply to"),
  inReplyTo: z.string().optional().describe("Message ID being replied to"),
  attachments: z.array(z.string()).optional().describe("List of file paths to attach to the email"),
});

export const ReadEmailSchema = z.object({
  messageId: z.string().describe("ID of the email message to retrieve"),
});

export const SearchEmailsSchema = z.object({
  query: z.string().describe("Gmail search query (e.g., 'from:example@gmail.com')"),
  maxResults: z.number().optional().describe("Maximum number of results to return"),
});

export const ModifyEmailSchema = z.object({
  messageId: z.string().describe("ID of the email message to modify"),
  labelIds: z.array(z.string()).optional().describe("List of label IDs to apply"),
  addLabelIds: z.array(z.string()).optional().describe("List of label IDs to add to the message"),
  removeLabelIds: z.array(z.string()).optional().describe("List of label IDs to remove from the message"),
});

export const DeleteEmailSchema = z.object({
  messageId: z.string().describe("ID of the email message to delete"),
});

export const ListEmailLabelsSchema = z.object({}).describe("Retrieves all available Gmail labels");

export const CreateLabelSchema = z.object({
  name: z.string().describe("Name for the new label"),
  messageListVisibility: z.enum(['show', 'hide']).optional().describe("Whether to show or hide the label in the message list"),
  labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe("Visibility of the label in the label list"),
}).describe("Creates a new Gmail label");

export const UpdateLabelSchema = z.object({
  id: z.string().describe("ID of the label to update"),
  name: z.string().optional().describe("New name for the label"),
  messageListVisibility: z.enum(['show', 'hide']).optional().describe("Whether to show or hide the label in the message list"),
  labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe("Visibility of the label in the label list"),
}).describe("Updates an existing Gmail label");

export const DeleteLabelSchema = z.object({
  id: z.string().describe("ID of the label to delete"),
}).describe("Deletes a Gmail label");

export const GetOrCreateLabelSchema = z.object({
  name: z.string().describe("Name of the label to get or create"),
  messageListVisibility: z.enum(['show', 'hide']).optional().describe("Whether to show or hide the label in the message list"),
  labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe("Visibility of the label in the label list"),
}).describe("Gets an existing label by name or creates it if it doesn't exist");

export const BatchModifyEmailsSchema = z.object({
  messageIds: z.array(z.string()).describe("List of message IDs to modify"),
  addLabelIds: z.array(z.string()).optional().describe("List of label IDs to add to all messages"),
  removeLabelIds: z.array(z.string()).optional().describe("List of label IDs to remove from all messages"),
  batchSize: z.number().optional().default(50).describe("Number of messages to process in each batch (default: 50)"),
});

export const BatchDeleteEmailsSchema = z.object({
  messageIds: z.array(z.string()).describe("List of message IDs to delete"),
  batchSize: z.number().optional().default(50).describe("Number of messages to process in each batch (default: 50)"),
});

export const CreateFilterSchema = z.object({
  criteria: z.object({
    from: z.string().optional().describe("Sender email address to match"),
    to: z.string().optional().describe("Recipient email address to match"),
    subject: z.string().optional().describe("Subject text to match"),
    query: z.string().optional().describe("Gmail search query (e.g., 'has:attachment')"),
    negatedQuery: z.string().optional().describe("Text that must NOT be present"),
    hasAttachment: z.boolean().optional().describe("Whether to match emails with attachments"),
    excludeChats: z.boolean().optional().describe("Whether to exclude chat messages"),
    size: z.number().optional().describe("Email size in bytes"),
    sizeComparison: z.enum(['unspecified', 'smaller', 'larger']).optional().describe("Size comparison operator")
  }).describe("Criteria for matching emails"),
  action: z.object({
    addLabelIds: z.array(z.string()).optional().describe("Label IDs to add to matching emails"),
    removeLabelIds: z.array(z.string()).optional().describe("Label IDs to remove from matching emails"),
    forward: z.string().optional().describe("Email address to forward matching emails to")
  }).describe("Actions to perform on matching emails")
}).describe("Creates a new Gmail filter");

export const ListFiltersSchema = z.object({}).describe("Retrieves all Gmail filters");

export const GetFilterSchema = z.object({
  filterId: z.string().describe("ID of the filter to retrieve")
}).describe("Gets details of a specific Gmail filter");

export const DeleteFilterSchema = z.object({
  filterId: z.string().describe("ID of the filter to delete")
}).describe("Deletes a Gmail filter");

export const CreateFilterFromTemplateSchema = z.object({
  template: z.enum(['fromSender', 'withSubject', 'withAttachments', 'largeEmails', 'containingText', 'mailingList']).describe("Pre-defined filter template to use"),
  parameters: z.object({
    senderEmail: z.string().optional().describe("Sender email (for fromSender template)"),
    subjectText: z.string().optional().describe("Subject text (for withSubject template)"),
    searchText: z.string().optional().describe("Text to search for (for containingText template)"),
    listIdentifier: z.string().optional().describe("Mailing list identifier (for mailingList template)"),
    sizeInBytes: z.number().optional().describe("Size threshold in bytes (for largeEmails template)"),
    labelIds: z.array(z.string()).optional().describe("Label IDs to apply"),
    archive: z.boolean().optional().describe("Whether to archive (skip inbox)"),
    markAsRead: z.boolean().optional().describe("Whether to mark as read"),
    markImportant: z.boolean().optional().describe("Whether to mark as important")
  }).describe("Template-specific parameters")
}).describe("Creates a filter using a pre-defined template");

export const DownloadAttachmentSchema = z.object({
  messageId: z.string().describe("ID of the email message containing the attachment"),
  attachmentId: z.string().describe("ID of the attachment to download"),
  filename: z.string().optional().describe("Filename to save the attachment as (if not provided, uses original filename)"),
  savePath: z.string().optional().describe("Directory path to save the attachment (defaults to current directory)"),
});

export const DownloadEmailSchema = z.object({
  messageId: z.string().describe("ID of the email message to download"),
  savePath: z.string().describe("Directory path to save the email file"),
  format: z.enum(['json', 'eml', 'txt', 'html']).optional().default('json')
    .describe("Output format: json (structured data), eml (raw RFC822), txt (plain text), html (formatted HTML)"),
});

// Reply All schema - fetches original email and builds recipient list automatically
export const ReplyAllSchema = z.object({
  messageId: z.string().describe("ID of the email message to reply to"),
  body: z.string().describe("Reply body content (used for text/plain or when htmlBody not provided)"),
  htmlBody: z.string().optional().describe("HTML version of the reply body"),
  mimeType: z.enum(['text/plain', 'text/html', 'multipart/alternative']).optional().default('text/plain').describe("Email content type"),
  attachments: z.array(z.string()).optional().describe("List of file paths to attach to the reply"),
});

// Tool definition type
export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodType<any>;
  scopes: string[]; // Any of these scopes grants access
}

// Tool registry with scope requirements
export const toolDefinitions: ToolDefinition[] = [
  // Read-only email operations
  {
    name: "read_email",
    description: "Retrieves the content of a specific email",
    schema: ReadEmailSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
  },
  {
    name: "search_emails",
    description: "Searches for emails using Gmail search syntax",
    schema: SearchEmailsSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
  },
  {
    name: "download_attachment",
    description: "Downloads an email attachment to a specified location",
    schema: DownloadAttachmentSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
  },
  {
    name: "download_email",
    description: "Downloads an email to a file in various formats (json, eml, txt, html). Returns metadata only - useful for saving emails without consuming context.",
    schema: DownloadEmailSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
  },

  // Email write operations
  {
    name: "send_email",
    description: "Sends a new email",
    schema: SendEmailSchema,
    scopes: ["gmail.modify", "gmail.compose", "gmail.send"],
  },
  {
    name: "draft_email",
    description: "Draft a new email",
    schema: SendEmailSchema,
    scopes: ["gmail.modify", "gmail.compose"],
  },
  {
    name: "modify_email",
    description: "Modifies email labels (move to different folders)",
    schema: ModifyEmailSchema,
    scopes: ["gmail.modify"],
  },
  {
    name: "delete_email",
    description: "Permanently deletes an email",
    schema: DeleteEmailSchema,
    scopes: ["gmail.modify"],
  },
  {
    name: "batch_modify_emails",
    description: "Modifies labels for multiple emails in batches",
    schema: BatchModifyEmailsSchema,
    scopes: ["gmail.modify"],
  },
  {
    name: "batch_delete_emails",
    description: "Permanently deletes multiple emails in batches",
    schema: BatchDeleteEmailsSchema,
    scopes: ["gmail.modify"],
  },

  // Label operations
  {
    name: "list_email_labels",
    description: "Retrieves all available Gmail labels",
    schema: ListEmailLabelsSchema,
    scopes: ["gmail.readonly", "gmail.modify", "gmail.labels"],
  },
  {
    name: "create_label",
    description: "Creates a new Gmail label",
    schema: CreateLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
  },
  {
    name: "update_label",
    description: "Updates an existing Gmail label",
    schema: UpdateLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
  },
  {
    name: "delete_label",
    description: "Deletes a Gmail label",
    schema: DeleteLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
  },
  {
    name: "get_or_create_label",
    description: "Gets an existing label by name or creates it if it doesn't exist",
    schema: GetOrCreateLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
  },

  // Filter operations (require settings scope)
  {
    name: "list_filters",
    description: "Retrieves all Gmail filters",
    schema: ListFiltersSchema,
    scopes: ["gmail.settings.basic"],
  },
  {
    name: "get_filter",
    description: "Gets details of a specific Gmail filter",
    schema: GetFilterSchema,
    scopes: ["gmail.settings.basic"],
  },
  {
    name: "create_filter",
    description: "Creates a new Gmail filter with custom criteria and actions",
    schema: CreateFilterSchema,
    scopes: ["gmail.settings.basic"],
  },
  {
    name: "delete_filter",
    description: "Deletes a Gmail filter",
    schema: DeleteFilterSchema,
    scopes: ["gmail.settings.basic"],
  },
  {
    name: "create_filter_from_template",
    description: "Creates a filter using a pre-defined template for common scenarios",
    schema: CreateFilterFromTemplateSchema,
    scopes: ["gmail.settings.basic"],
  },

  // Reply-all operation
  {
    name: "reply_all",
    description: "Replies to all recipients of an email. Automatically fetches the original email to build the recipient list (To, CC) and sets proper threading headers.",
    schema: ReplyAllSchema,
    scopes: ["gmail.modify", "gmail.compose", "gmail.send"],
  },
];

// Convert tool definitions to MCP tool format
export function toMcpTools(tools: ToolDefinition[]) {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.schema),
  }));
}

// Get a tool definition by name
export function getToolByName(name: string): ToolDefinition | undefined {
  return toolDefinitions.find(t => t.name === name);
}
