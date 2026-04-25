/**
 * Label Manager for Gmail MCP Server
 * Provides comprehensive label management functionality
 */

import type { gmail_v1 } from "googleapis";
import { asGmailApiError } from "./gmail-errors.js";

// Re-export googleapis' Schema$Label under our historical name so call
// sites can keep using `GmailLabel` unchanged while benefiting from the
// canonical (nullable) typing the SDK actually returns.
export type GmailLabel = gmail_v1.Schema$Label;

/**
 * Sentinel thrown by createLabel() when the Gmail API reports a
 * duplicate, so the TOCTOU recovery in getOrCreateLabel() can detect
 * the race via `instanceof` instead of grep-ing a user-facing message.
 */
export class DuplicateLabelError extends Error {
  constructor(labelName: string, options?: { cause?: unknown }) {
    super(`Label "${labelName}" already exists. Please use a different name.`, options);
    this.name = "DuplicateLabelError";
  }
}

/**
 * Sentinel thrown by deleteLabel() when the target is a Gmail system
 * label, so the generic catch can re-throw the specific message
 * unchanged instead of swallowing it under a Gaxios-error wrapper.
 */
export class SystemLabelProtectionError extends Error {
  constructor(labelId: string) {
    super(`Cannot delete system label with ID "${labelId}".`);
    this.name = "SystemLabelProtectionError";
  }
}

/**
 * Creates a new Gmail label
 * @param gmail - Gmail API instance
 * @param labelName - Name of the label to create
 * @param options - Optional settings for the label
 * @returns The newly created label
 */
export async function createLabel(
  gmail: gmail_v1.Gmail,
  labelName: string,
  options: {
    messageListVisibility?: string;
    labelListVisibility?: string;
  } = {},
) {
  try {
    // Default visibility settings if not provided
    const messageListVisibility = options.messageListVisibility || "show";
    const labelListVisibility = options.labelListVisibility || "labelShow";

    const response = await gmail.users.labels.create({
      userId: "me",
      requestBody: {
        name: labelName,
        messageListVisibility,
        labelListVisibility,
      },
    });

    return response.data;
  } catch (err: unknown) {
    const error = asGmailApiError(err);
    // 409 = unambiguous duplicate. 400 is generic (also invalid names /
    // missing fields) so require a corroborating message match. For
    // network-layer errors with no status at all, fall back to the
    // message alone.
    const messageIndicatesDuplicate = error.message.includes("already exists");
    const isDuplicate =
      error.code === 409 ||
      (error.code === 400 && messageIndicatesDuplicate) ||
      (error.code === undefined && messageIndicatesDuplicate);
    if (isDuplicate) {
      throw new DuplicateLabelError(labelName, { cause: err });
    }

    throw new Error(`Failed to create label: ${error.message}`, { cause: err });
  }
}

/**
 * Updates an existing Gmail label
 * @param gmail - Gmail API instance
 * @param labelId - ID of the label to update
 * @param updates - Properties to update
 * @returns The updated label
 */
export async function updateLabel(
  gmail: gmail_v1.Gmail,
  labelId: string,
  updates: {
    name?: string;
    messageListVisibility?: string;
    labelListVisibility?: string;
  },
) {
  try {
    const response = await gmail.users.labels.update({
      userId: "me",
      id: labelId,
      requestBody: updates,
    });

    return response.data;
  } catch (err: unknown) {
    const error = asGmailApiError(err);
    if (error.code === 404) {
      throw new Error(`Label with ID "${labelId}" not found.`, { cause: err });
    }

    throw new Error(`Failed to update label: ${error.message}`, { cause: err });
  }
}

/**
 * Deletes a Gmail label
 * @param gmail - Gmail API instance
 * @param labelId - ID of the label to delete
 * @returns Success message
 */
export async function deleteLabel(gmail: gmail_v1.Gmail, labelId: string) {
  try {
    // Ensure we're not trying to delete system labels
    const label = await gmail.users.labels.get({
      userId: "me",
      id: labelId,
    });

    if (label.data.type === "system") {
      throw new SystemLabelProtectionError(labelId);
    }

    await gmail.users.labels.delete({
      userId: "me",
      id: labelId,
    });

    return { success: true, message: `Label "${label.data.name}" deleted successfully.` };
  } catch (err: unknown) {
    // Let our own system-label rejection bubble up with its specific
    // message intact instead of being swallowed by the generic catch.
    if (err instanceof SystemLabelProtectionError) throw err;

    const error = asGmailApiError(err);
    if (error.code === 404) {
      throw new Error(`Label with ID "${labelId}" not found.`, { cause: err });
    }

    throw new Error(`Failed to delete label: ${error.message}`, { cause: err });
  }
}

/**
 * Gets a detailed list of all Gmail labels
 * @param gmail - Gmail API instance
 * @returns Object containing system and user labels
 */
export async function listLabels(gmail: gmail_v1.Gmail) {
  try {
    const response = await gmail.users.labels.list({
      userId: "me",
    });

    const labels = response.data.labels || [];

    // Group labels by type for better organization
    const systemLabels = labels.filter((label) => label.type === "system");
    const userLabels = labels.filter((label) => label.type === "user");

    return {
      all: labels,
      system: systemLabels,
      user: userLabels,
      count: {
        total: labels.length,
        system: systemLabels.length,
        user: userLabels.length,
      },
    };
  } catch (err: unknown) {
    const error = asGmailApiError(err);
    throw new Error(`Failed to list labels: ${error.message}`, { cause: err });
  }
}

/**
 * Finds a label by name
 * @param gmail - Gmail API instance
 * @param labelName - Name of the label to find
 * @returns The found label or null if not found
 */
export async function findLabelByName(gmail: gmail_v1.Gmail, labelName: string) {
  try {
    const labelsResponse = await listLabels(gmail);
    const allLabels = labelsResponse.all;

    // Case-insensitive match
    const foundLabel = allLabels.find(
      (label) => label.name?.toLowerCase() === labelName.toLowerCase(),
    );

    return foundLabel || null;
  } catch (err: unknown) {
    const error = asGmailApiError(err);
    throw new Error(`Failed to find label: ${error.message}`, { cause: err });
  }
}

/**
 * Creates label if it doesn't exist or returns existing label
 * @param gmail - Gmail API instance
 * @param labelName - Name of the label to create
 * @param options - Optional settings for the label
 * @returns The new or existing label
 */
/**
 * Result of `getOrCreateLabel`: the label itself plus an explicit
 * `found` flag distinguishing the "label was already there" path from
 * the "we just created it" path. Callers that need to surface this
 * difference (e.g. `tools/labels.ts` rendering "found existing" vs
 * "created new") use the flag instead of pattern-matching on
 * `label.type` / `label.name`, which cannot reliably tell the two
 * paths apart since `findLabelByName` and `createLabel` both return
 * identical `Schema$Label` shapes. CR finding on PR #84.
 */
export interface GetOrCreateLabelResult {
  label: GmailLabel;
  /** True when `findLabelByName` returned a hit; false when `createLabel` ran. */
  found: boolean;
}

export async function getOrCreateLabel(
  gmail: gmail_v1.Gmail,
  labelName: string,
  options: {
    messageListVisibility?: string;
    labelListVisibility?: string;
  } = {},
): Promise<GetOrCreateLabelResult> {
  try {
    // First try to find an existing label
    const existingLabel = await findLabelByName(gmail, labelName);

    if (existingLabel) {
      return { label: existingLabel, found: true };
    }

    // TOCTOU: another caller can create the label between the
    // findLabelByName above and this create. Recover by rescanning.
    try {
      const created = await createLabel(gmail, labelName, options);
      return { label: created, found: false };
    } catch (createErr: unknown) {
      if (createErr instanceof DuplicateLabelError) {
        const racedLabel = await findLabelByName(gmail, labelName);
        if (racedLabel) return { label: racedLabel, found: true };
      }
      throw createErr;
    }
  } catch (err: unknown) {
    const error = asGmailApiError(err);
    throw new Error(`Failed to get or create label: ${error.message}`, { cause: err });
  }
}
