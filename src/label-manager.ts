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
 * Dedicated sentinel so the TOCTOU recovery in getOrCreateLabel can
 * detect a racing duplicate without keying off the user-facing message
 * text of a wrapped Error (which would break silently on a copy change).
 */
export class DuplicateLabelError extends Error {
  constructor(labelName: string, options?: { cause?: unknown }) {
    super(`Label "${labelName}" already exists. Please use a different name.`, options);
    this.name = "DuplicateLabelError";
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
    // Duplicate-label detection: Gmail API returns HTTP 409 Conflict
    // unambiguously for an existing name, so that's a Met-signal on
    // its own. 400 Bad Request is generic (also fires on invalid
    // names, missing fields, etc.) — require a corroborating message
    // match. For network-layer errors with no status at all, fall
    // back to message matching alone.
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
    // Skip the preflight `labels.get()` — labels.update() is the source of
    // truth. The preflight added an extra Gmail round-trip without closing
    // any race (the label can still vanish between the get and the update),
    // and the 404 path in the catch already surfaces the missing-label case.
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
// Sentinel so the generic catch can tell our own pre-flight rejection
// apart from a Gaxios error and re-throw the specific message unchanged.
class SystemLabelProtectionError extends Error {
  constructor(labelId: string) {
    super(`Cannot delete system label with ID "${labelId}".`);
    this.name = "SystemLabelProtectionError";
  }
}

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
export async function getOrCreateLabel(
  gmail: gmail_v1.Gmail,
  labelName: string,
  options: {
    messageListVisibility?: string;
    labelListVisibility?: string;
  } = {},
) {
  try {
    // First try to find an existing label
    const existingLabel = await findLabelByName(gmail, labelName);

    if (existingLabel) {
      return existingLabel;
    }

    // If not found, create a new one. There is an inherent TOCTOU
    // window between the findLabelByName() above and this create:
    // another caller (or another agent session) can win the race and
    // create the same label first, which makes createLabel throw a
    // DuplicateLabelError. Recover by re-scanning and returning
    // whatever landed — honours the "get or create" contract under
    // concurrency rather than surfacing the duplicate error.
    //
    // Detecting the race via the sentinel class (not a substring match
    // on the user-facing message) keeps the recovery robust against
    // future copy changes in createLabel's error message.
    try {
      return await createLabel(gmail, labelName, options);
    } catch (createErr: unknown) {
      if (createErr instanceof DuplicateLabelError) {
        const racedLabel = await findLabelByName(gmail, labelName);
        if (racedLabel) return racedLabel;
      }
      throw createErr;
    }
  } catch (err: unknown) {
    const error = asGmailApiError(err);
    throw new Error(`Failed to get or create label: ${error.message}`, { cause: err });
  }
}
