/**
 * Email export utilities for converting Gmail messages to various formats
 */

// Types
export interface ParsedAddress {
	name: string;
	email: string;
}

export interface EmailAttachment {
	id: string;
	filename: string;
	mimeType: string;
	size: number;
}

export interface EmailJson {
	messageId: string;
	threadId: string;
	subject: string;
	from: ParsedAddress;
	to: ParsedAddress[];
	cc: ParsedAddress[];
	bcc: ParsedAddress[];
	date: string;
	labels: string[];
	snippet: string;
	body: {
		plain: string;
		html: string;
	};
	attachments: EmailAttachment[];
	headers: Record<string, string>;
}

/**
 * Parse email address string into name and email components
 * Handles formats like:
 * - "John Doe" <john@example.com>
 * - John Doe <john@example.com>
 * - john@example.com
 */
export function parseEmailAddress(address: string): ParsedAddress {
	if (!address) return { name: "", email: "" };

	// Try to match "Name" <email> or Name <email> pattern
	const match = address.match(/^(?:"?([^"<]*)"?\s*)?<?([^>]+@[^>]+)>?$/);
	if (match) {
		return {
			name: (match[1] || "").trim(),
			email: match[2].trim(),
		};
	}
	return { name: "", email: address.trim() };
}

/**
 * Parse comma-separated list of email addresses
 */
export function parseEmailAddresses(addresses: string | undefined): ParsedAddress[] {
	if (!addresses) return [];
	// Split on comma but not inside quotes
	const parts = addresses.match(/(?:[^,"]|"[^"]*")+/g) || [];
	return parts.map((part) => parseEmailAddress(part.trim())).filter((a) => a.email);
}

/**
 * Convert Gmail API message to structured JSON
 */
export function gmailMessageToJson(
	message: any,
	emailContent: { text: string; html: string },
	attachments: EmailAttachment[]
): EmailJson {
	const headers = message.payload?.headers || [];
	const getHeader = (name: string) =>
		headers.find((h: any) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";

	const dateStr = getHeader("date");
	let isoDate = "";
	try {
		isoDate = new Date(dateStr).toISOString();
	} catch {
		isoDate = dateStr; // Keep original if parsing fails
	}

	return {
		messageId: message.id,
		threadId: message.threadId,
		subject: getHeader("subject"),
		from: parseEmailAddress(getHeader("from")),
		to: parseEmailAddresses(getHeader("to")),
		cc: parseEmailAddresses(getHeader("cc")),
		bcc: parseEmailAddresses(getHeader("bcc")),
		date: isoDate,
		labels: message.labelIds || [],
		snippet: message.snippet || "",
		body: {
			plain: emailContent.text,
			html: emailContent.html,
		},
		attachments,
		headers: {
			"Message-ID": getHeader("message-id"),
			"In-Reply-To": getHeader("in-reply-to"),
			References: getHeader("references"),
		},
	};
}

/**
 * Format address for display
 */
function formatAddress(a: ParsedAddress): string {
	return a.name ? `${a.name} <${a.email}>` : a.email;
}

/**
 * Format list of addresses for display
 */
function formatAddresses(addrs: ParsedAddress[]): string {
	return addrs.map(formatAddress).join(", ");
}

/**
 * Convert email to plain text format
 */
export function emailToTxt(
	message: any,
	emailContent: { text: string; html: string },
	attachments: EmailAttachment[]
): string {
	const headers = message.payload?.headers || [];
	const getHeader = (name: string) =>
		headers.find((h: any) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";

	const from = getHeader("from");
	const to = getHeader("to");
	const cc = getHeader("cc");
	const subject = getHeader("subject");
	const date = getHeader("date");

	const lines = [`From: ${from}`, `To: ${to}`];

	if (cc) {
		lines.push(`CC: ${cc}`);
	}

	lines.push(`Subject: ${subject}`);
	lines.push(`Date: ${date}`);
	lines.push("");
	lines.push(emailContent.text || "[No plain text content]");

	if (attachments.length > 0) {
		lines.push("");
		lines.push("---");
		lines.push(`Attachments: ${attachments.map((a) => a.filename).join(", ")}`);
	}

	return lines.join("\n");
}

/**
 * Extract HTML content from email, or throw if none exists
 */
export function emailToHtml(emailContent: { text: string; html: string }): string {
	if (!emailContent.html) {
		throw new Error("This email has no HTML content");
	}
	return emailContent.html;
}
