import { z } from "zod";

/**
 * User-facing slash commands exposed via the MCP prompts capability
 * (https://modelcontextprotocol.io/specification/2025-11-25/server/prompts).
 *
 * Prompts are user-controlled: MCP clients like Claude Desktop surface
 * them as slash commands so a human explicitly picks one before the LLM
 * runs the underlying tool chain. Each body below deliberately names the
 * `gmail-mcp` tools the LLM should call, so the model does not have to
 * re-discover the tool set every invocation.
 *
 * These prompts cover the six most common flows requested by the
 * maintainer:
 *   1. list unread mail
 *   2. list unread older than a threshold
 *   3. auto-reclass inbox by kind (newsletter / notif / social / forum)
 *   4. flag phishing
 *   5. flag undetected spam
 *   6. unread triage with per-email recommendation
 *
 * gmail-mcp still uses the SDK's legacy `Server` API (see ROADMAP entry
 * "Migrate Server (legacy) → McpServer"), so prompts are wired via the
 * `ListPromptsRequestSchema` / `GetPromptRequestSchema` handlers in
 * src/index.ts rather than via the higher-level `server.registerPrompt`.
 */

export interface PromptArg {
  name: string;
  description: string;
  required?: boolean;
}

export interface PromptInfo {
  name: string;
  title: string;
  description: string;
  arguments: PromptArg[];
}

export interface PromptMessage {
  role: "user";
  content: { type: "text"; text: string };
}

export interface PromptResult {
  description: string;
  messages: PromptMessage[];
}

/**
 * Prompt name literal — derived from PROMPTS so schemas / bodies can be
 * constrained to the same key set via `satisfies`. If a new prompt is
 * added to PROMPTS but forgotten in schemas or bodies, the compile
 * catches it instead of a runtime Zod error with a confusing stack.
 */
type PromptName =
  | "unread-emails"
  | "unread-stale"
  | "inbox-reclass"
  | "detect-phishing"
  | "detect-spam"
  | "unread-triage";

/** Zod schemas per prompt — used to validate + coerce caller-supplied args. */
const schemas = {
  "unread-emails": z.object({}).strict(),
  "unread-stale": z
    .object({
      olderThan: z.string().describe("Gmail `older_than:` operator value, e.g. `7d`, `1m`, `2w`."),
    })
    .strict(),
  "inbox-reclass": z.object({}).strict(),
  "detect-phishing": z.object({}).strict(),
  "detect-spam": z.object({}).strict(),
  "unread-triage": z.object({}).strict(),
} as const satisfies Record<PromptName, z.ZodType>;

export const PROMPTS: PromptInfo[] = [
  {
    name: "unread-emails",
    title: "List unread emails",
    description: "Show every unread email in the inbox with sender, subject, and date.",
    arguments: [],
  },
  {
    name: "unread-stale",
    title: "List stale unread emails",
    description:
      "Show unread emails older than a threshold (e.g. `7d`, `1m`) that haven't been processed.",
    arguments: [
      {
        name: "olderThan",
        description: "Gmail `older_than:` operator value (e.g. `7d`, `1m`, `2w`).",
        required: true,
      },
    ],
  },
  {
    name: "inbox-reclass",
    title: "Auto-reclass inbox by kind",
    description:
      "Sort the inbox and apply the correct label: newsletters → Newsletters, notifications → Notifications, social networks → Social, forums → Forums.",
    arguments: [],
  },
  {
    name: "detect-phishing",
    title: "Flag phishing emails",
    description: "Scan the inbox for phishing indicators and tag matches with a `Phishing` label.",
    arguments: [],
  },
  {
    name: "detect-spam",
    title: "Flag spam that Gmail missed",
    description:
      "Scan the inbox for spam indicators that Gmail's own filter missed and tag matches with a `Spam` label (without auto-moving — the user decides).",
    arguments: [],
  },
  {
    name: "unread-triage",
    title: "Triage unread emails with recommendation",
    description:
      "List every unread email grouped by category, each with a recommended action (archive / reply / delete) so the user can pick per entry.",
    arguments: [],
  },
];

const bodies = {
  "unread-emails": () =>
    `Use \`search_emails\` with query \`is:unread in:inbox\` (maxResults ≤ 100). ` +
    `For each hit, show: sender, subject, date received, and the first ~80 chars of the preview. ` +
    `Return a compact markdown table so the user can scan it quickly. ` +
    `Do NOT open the full body of each email (that burns unnecessary Gmail API quota); ` +
    `only \`read_email\` for entries the user explicitly asks about in follow-up.`,

  "unread-stale": (args) =>
    `Use \`search_emails\` with query \`is:unread in:inbox older_than:${args.olderThan}\` (maxResults ≤ 200). ` +
    `For each hit, show: sender, subject, date received, days since received, and the first ~80 chars of the preview. ` +
    `Sort oldest-first so the most neglected threads are at the top. ` +
    `End with a one-line count of how many stale unread emails were found and a suggestion ` +
    `to run the \`/unread-triage\` prompt if the list is large.`,

  "inbox-reclass": () =>
    `Objective: sort every email in the inbox into one of four categories and apply the matching Gmail label, WITHOUT deleting or archiving anything.\n\n` +
    `Steps:\n` +
    `1. Call \`list_email_labels\` once to discover existing user labels.\n` +
    `2. Call \`get_or_create_label\` for each of: \`Newsletters\`, \`Notifications\`, \`Social\`, \`Forums\` ` +
    `   — reuse the existing IDs if the labels already exist.\n` +
    `3. Call \`search_emails\` with query \`in:inbox\` (maxResults ≤ 500) to fetch the current inbox.\n` +
    `4. For each email, classify using the following heuristics:\n` +
    `   - **Newsletters**: bulk sender domains, typical marketing footers, \`list-unsubscribe\` header, ` +
    `subjects with "🎉", "Weekly Digest", "Newsletter", "Your … update".\n` +
    `   - **Notifications**: automated senders (\`noreply@\`, \`no-reply@\`, \`alerts@\`, \`notifications@\`), ` +
    `subjects like "… has been updated", "Verification code", "Your … receipt".\n` +
    `   - **Social**: senders from facebook.com, linkedin.com, twitter.com, instagram.com, tiktok.com, mastodon, bluesky; ` +
    `subjects about friend requests, comments, mentions, new followers.\n` +
    `   - **Forums**: senders from github.com (notifications), discourse instances, reddit.com, ` +
    `hackernews, mailman/google-groups digests; subjects starting with \`[listname]\` prefix.\n` +
    `5. Apply the matching label via \`batch_modify_emails\` (1 batch call per category to minimise API load). ` +
    `Do NOT also remove the \`INBOX\` label — this is a classification pass, not an archive pass.\n` +
    `6. Emails that don't match any category: leave untouched (no guess-labeling).\n\n` +
    `Report at the end: how many emails went into each category, and how many were left unclassified. ` +
    `Do not modify anything outside the inbox.`,

  "detect-phishing": () =>
    `Objective: find phishing attempts in the inbox and tag them with a \`Phishing\` label (without moving, so the user can review before deciding).\n\n` +
    `Steps:\n` +
    `1. Call \`get_or_create_label\` for \`Phishing\`.\n` +
    `2. Call \`search_emails\` with query \`in:inbox -label:Phishing\` (maxResults ≤ 200).\n` +
    `3. For each email, inspect using \`read_email\` ONLY if the headers look suspicious — otherwise skip to save quota.\n` +
    `4. Phishing indicators to weight (the more present, the higher the score):\n` +
    `   - Sender display name impersonating a known brand but domain doesn't match (e.g. \`PayPaI\` with capital-I).\n` +
    `   - Urgency / fear language in subject: "Your account will be closed", "Unusual activity", "Verify now".\n` +
    `   - Mismatched or obfuscated links: href points to a short URL, IP literal, or random-looking domain ` +
    `different from the visible anchor text.\n` +
    `   - Credential-harvesting asks: "re-enter your password", "confirm your SSN", "verify your card".\n` +
    `   - Attachment with generic name (\`invoice.pdf\`, \`document.html\`) from an unexpected sender.\n` +
    `   - DMARC/SPF failure hints in \`from\` / \`return-path\` mismatch.\n` +
    `5. For matches: call \`batch_modify_emails\` to add the \`Phishing\` label (do NOT remove \`INBOX\` — the user will triage).\n\n` +
    `Report: how many flagged, listing sender + subject + top 1–2 indicators per entry. ` +
    `Do not auto-delete, auto-archive, or reply — the user decides the next step.`,

  "detect-spam": () =>
    `Objective: find spam that Gmail's own filter missed (emails still sitting in the inbox rather than \`SPAM\`) and tag them with a \`Spam\` label so the user can review and bulk-move.\n\n` +
    `Steps:\n` +
    `1. Call \`get_or_create_label\` for \`Spam\` (custom label, distinct from Gmail's built-in \`SPAM\` system label — we do NOT want to auto-move to trash).\n` +
    `2. Call \`search_emails\` with query \`in:inbox -label:Spam\` (maxResults ≤ 200).\n` +
    `3. Score each email on these signals:\n` +
    `   - Unknown sender with no prior correspondence AND promotional language ("limited offer", "click here", "free").\n` +
    `   - Subject-line tricks: excessive punctuation ("!!!"), ALL CAPS, Unicode homoglyphs, promotional emoji spam.\n` +
    `   - Body is 95%+ HTML with no plain-text alternative and heavy image reliance.\n` +
    `   - No \`list-unsubscribe\` header (legitimate newsletters always have one) but still bulk-formatted.\n` +
    `   - Sender domain recently registered or in known bulk-sender patterns.\n` +
    `4. Apply \`Spam\` label via \`batch_modify_emails\` on matches. Do NOT remove \`INBOX\` and do NOT apply Gmail's built-in \`SPAM\` label ` +
    `(that would short-circuit the user's review).\n\n` +
    `Report: count + per-entry justification. The user will decide whether to bulk-archive, bulk-delete, or train Gmail's filter by moving them manually.`,

  "unread-triage": () =>
    `Objective: produce a per-email triage table from the unread inbox so the user can decide archive/reply/delete one entry at a time.\n\n` +
    `Steps:\n` +
    `1. Call \`search_emails\` with query \`is:unread in:inbox\` (maxResults ≤ 100).\n` +
    `2. For each email, inspect just the subject + sender + first ~200 chars of preview (via \`read_email\` if needed — but only if the headers alone aren't enough to classify).\n` +
    `3. Assign one of these categories:\n` +
    `   - \`Work\` — from colleagues, work-domain senders, project-related subjects.\n` +
    `   - \`Personal\` — from known personal contacts.\n` +
    `   - \`Transactional\` — receipts, confirmations, verification codes.\n` +
    `   - \`Newsletter\` — bulk marketing, digests.\n` +
    `   - \`Notification\` — automated alerts (no human content).\n` +
    `   - \`Social\` — facebook/linkedin/twitter notifications.\n` +
    `   - \`Forum\` — github/discourse/mailing-list notifications.\n` +
    `   - \`Junk\` — unsolicited promos, low-quality cold outreach.\n` +
    `4. For each email, assign a recommendation:\n` +
    `   - \`Archive\` — read-only, no action needed (receipts, most notifications).\n` +
    `   - \`Reply\` — a human is waiting on a reply (work/personal correspondence).\n` +
    `   - \`Delete\` — junk, clearly spam, no archival value.\n\n` +
    `Output format: a single markdown table grouped by category, columns:\n` +
    `  \`#\` | \`sender\` | \`subject\` | \`recommendation\` | \`one-line rationale\`\n\n` +
    `End with: "Reply with the numbers you want me to [archive/reply to/delete] and I will run the corresponding tool calls."`,
} as const satisfies Record<PromptName, (args: Record<string, string>) => string>;

export function listPrompts(): PromptInfo[] {
  return PROMPTS;
}

export function getPrompt(name: string, args: Record<string, unknown> | undefined): PromptResult {
  const info = PROMPTS.find((p) => p.name === name);
  if (!info) {
    throw new Error(`Unknown prompt: "${name}"`);
  }
  const schema = schemas[name as PromptName];
  const parsed = schema.parse(args ?? {}) as Record<string, string>;
  const body = bodies[name as PromptName](parsed);
  return {
    description: info.description,
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text: body },
      },
    ],
  };
}
