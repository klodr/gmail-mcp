/**
 * Filter Manager for Gmail MCP Server
 * Provides comprehensive filter management functionality
 */

import type { gmail_v1 } from "googleapis";
import { asGmailApiError } from "./gmail-errors.js";

// Type definitions for Gmail API filters
export interface GmailFilterCriteria {
  from?: string;
  to?: string;
  subject?: string;
  query?: string;
  negatedQuery?: string;
  hasAttachment?: boolean;
  excludeChats?: boolean;
  size?: number;
  sizeComparison?: "unspecified" | "smaller" | "larger";
}

export interface GmailFilterAction {
  addLabelIds?: string[];
  removeLabelIds?: string[];
  forward?: string;
}

export interface GmailFilter {
  id?: string;
  criteria: GmailFilterCriteria;
  action: GmailFilterAction;
}

/**
 * Creates a new Gmail filter
 * @param gmail - Gmail API instance
 * @param criteria - Filter criteria to match messages
 * @param action - Actions to perform on matching messages
 * @returns The newly created filter
 */
export async function createFilter(
  gmail: gmail_v1.Gmail,
  criteria: GmailFilterCriteria,
  action: GmailFilterAction,
) {
  try {
    const filterBody: GmailFilter = {
      criteria,
      action,
    };

    const response = await gmail.users.settings.filters.create({
      userId: "me",
      requestBody: filterBody,
    });

    return response.data;
  } catch (err: unknown) {
    const error = asGmailApiError(err);
    if (error.code === 400) {
      throw new Error(`Invalid filter criteria or action: ${error.message}`, { cause: err });
    }
    throw new Error(`Failed to create filter: ${error.message}`, { cause: err });
  }
}

/**
 * Lists all Gmail filters
 * @param gmail - Gmail API instance
 * @returns Array of all filters
 */
export async function listFilters(gmail: gmail_v1.Gmail) {
  try {
    const response = await gmail.users.settings.filters.list({
      userId: "me",
    });

    const filters = response.data.filter || [];

    return {
      filters,
      count: filters.length,
    };
  } catch (err: unknown) {
    const error = asGmailApiError(err);
    throw new Error(`Failed to list filters: ${error.message}`, { cause: err });
  }
}

/**
 * Gets a specific Gmail filter by ID
 * @param gmail - Gmail API instance
 * @param filterId - ID of the filter to retrieve
 * @returns The filter details
 */
export async function getFilter(gmail: gmail_v1.Gmail, filterId: string) {
  try {
    const response = await gmail.users.settings.filters.get({
      userId: "me",
      id: filterId,
    });

    return response.data;
  } catch (err: unknown) {
    const error = asGmailApiError(err);
    if (error.code === 404) {
      throw new Error(`Filter with ID "${filterId}" not found.`, { cause: err });
    }
    throw new Error(`Failed to get filter: ${error.message}`, { cause: err });
  }
}

/**
 * Deletes a Gmail filter
 * @param gmail - Gmail API instance
 * @param filterId - ID of the filter to delete
 * @returns Success message
 */
export async function deleteFilter(gmail: gmail_v1.Gmail, filterId: string) {
  try {
    await gmail.users.settings.filters.delete({
      userId: "me",
      id: filterId,
    });

    return { success: true, message: `Filter "${filterId}" deleted successfully.` };
  } catch (err: unknown) {
    const error = asGmailApiError(err);
    if (error.code === 404) {
      throw new Error(`Filter with ID "${filterId}" not found.`, { cause: err });
    }
    throw new Error(`Failed to delete filter: ${error.message}`, { cause: err });
  }
}

/**
 * Canonical filter patterns for the `create_filter_from_template` tool.
 *
 * Each template returns a ready-to-use `{ criteria, action }` shape the
 * caller passes straight to `gmail.users.settings.filters.create`.
 * Templates capture the one intention per entry (route by sender, by
 * subject, by size, …) so the tool surface stays opinionated and the
 * LLM does not have to compose `criteria` + `action` from scratch.
 */
export const filterTemplates = {
  /**
   * Filter inbound messages whose `From` matches a specific sender.
   *
   * @param senderEmail - Email address to match (exact or substring;
   *                      Gmail's `from:` operator)
   * @param labelIds - Labels to add to matching messages
   * @param archive - When `true`, also remove `INBOX` so matches skip
   *                  the inbox and land only under the added labels
   * @returns Filter `{ criteria, action }` ready for the Gmail API
   */
  fromSender: (
    senderEmail: string,
    labelIds: string[] = [],
    archive: boolean = false,
  ): { criteria: GmailFilterCriteria; action: GmailFilterAction } => ({
    criteria: { from: senderEmail },
    action: {
      addLabelIds: labelIds,
      removeLabelIds: archive ? ["INBOX"] : undefined,
    },
  }),

  /**
   * Filter inbound messages whose `Subject` matches a specific string.
   *
   * @param subjectText - Subject string to match (Gmail's `subject:`
   *                      operator — full-word match, case-insensitive)
   * @param labelIds - Labels to add to matching messages
   * @param markAsRead - When `true`, also remove `UNREAD` so matches
   *                     arrive pre-read
   * @returns Filter `{ criteria, action }` ready for the Gmail API
   */
  withSubject: (
    subjectText: string,
    labelIds: string[] = [],
    markAsRead: boolean = false,
  ): { criteria: GmailFilterCriteria; action: GmailFilterAction } => ({
    criteria: { subject: subjectText },
    action: {
      addLabelIds: labelIds,
      removeLabelIds: markAsRead ? ["UNREAD"] : undefined,
    },
  }),

  /**
   * Filter inbound messages that carry at least one attachment.
   *
   * @param labelIds - Labels to add to matching messages
   * @returns Filter `{ criteria, action }` ready for the Gmail API
   */
  withAttachments: (
    labelIds: string[] = [],
  ): { criteria: GmailFilterCriteria; action: GmailFilterAction } => ({
    criteria: { hasAttachment: true },
    action: { addLabelIds: labelIds },
  }),

  /**
   * Filter inbound messages above a size threshold. Uses the Gmail
   * `size` criterion with `"larger"` comparison — the underlying API
   * counts bytes including encoded attachments.
   *
   * @param sizeInBytes - Lower bound in bytes (strict "larger than")
   * @param labelIds - Labels to add to matching messages
   * @returns Filter `{ criteria, action }` ready for the Gmail API
   */
  largeEmails: (
    sizeInBytes: number,
    labelIds: string[] = [],
  ): { criteria: GmailFilterCriteria; action: GmailFilterAction } => ({
    criteria: { size: sizeInBytes, sizeComparison: "larger" },
    action: { addLabelIds: labelIds },
  }),

  /**
   * Filter inbound messages whose body or headers contain a specific
   * text fragment. The string is emitted quoted so the Gmail search
   * parser treats it as a phrase match rather than whitespace-split
   * tokens.
   *
   * @param searchText - Literal text to look for (wrapped in quotes
   *                     before being passed as a Gmail `query`)
   * @param labelIds - Labels to add to matching messages
   * @param markImportant - When `true`, also adds the `IMPORTANT`
   *                        system label so Gmail surfaces the match
   * @returns Filter `{ criteria, action }` ready for the Gmail API
   */
  containingText: (
    searchText: string,
    labelIds: string[] = [],
    markImportant: boolean = false,
  ): { criteria: GmailFilterCriteria; action: GmailFilterAction } => ({
    criteria: { query: `"${searchText}"` },
    action: {
      addLabelIds: markImportant ? [...labelIds, "IMPORTANT"] : labelIds,
    },
  }),

  /**
   * Filter mailing-list inbound messages. Matches both the standard
   * RFC 2369 `List-Id` header (via `list:` operator) and legacy
   * `Subject: [listname] …` tags, since many lists only set one.
   *
   * @param listIdentifier - List-Id or bracketed-subject tag to match
   * @param labelIds - Labels to add to matching messages
   * @param archive - When `true` (default), also remove `INBOX` so
   *                  list messages skip the inbox and stay under the
   *                  added labels only
   * @returns Filter `{ criteria, action }` ready for the Gmail API
   */
  mailingList: (
    listIdentifier: string,
    labelIds: string[] = [],
    archive: boolean = true,
  ): { criteria: GmailFilterCriteria; action: GmailFilterAction } => ({
    criteria: { query: `list:${listIdentifier} OR subject:[${listIdentifier}]` },
    action: {
      addLabelIds: labelIds,
      removeLabelIds: archive ? ["INBOX"] : undefined,
    },
  }),
};
