/**
 * End-to-end coverage for the download_attachment handler in
 * src/tools/downloads.ts. download_email is covered through
 * src/download-email.test.ts (format-specific assertions on the
 * email-export helpers); this file targets download_attachment's
 * branches that the helper-level suite cannot reach.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { gmail_v1 } from "googleapis";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";

interface MockOpts {
  attachmentBytes?: string;
  fullMessagePayload?: unknown;
}

function makeMockGmail(opts: MockOpts = {}): {
  gmail: gmail_v1.Gmail;
  attachmentGetSpy: ReturnType<typeof vi.fn>;
  messageGetSpy: ReturnType<typeof vi.fn>;
} {
  const bytes = opts.attachmentBytes ?? "Hello, world.";
  const attachmentGetSpy = vi.fn(() =>
    Promise.resolve({ data: { data: Buffer.from(bytes).toString("base64url") } }),
  );
  const messageGetSpy = vi.fn(() =>
    Promise.resolve({
      data: {
        id: "M-1",
        threadId: "T-1",
        payload: opts.fullMessagePayload ?? {
          mimeType: "multipart/mixed",
          parts: [
            { mimeType: "text/plain", body: { data: Buffer.from("body").toString("base64url") } },
            {
              filename: "report.pdf",
              mimeType: "application/pdf",
              body: { attachmentId: "ATT-1", size: bytes.length },
            },
          ],
        },
      },
    }),
  );
  const gmail = {
    users: {
      messages: {
        attachments: { get: attachmentGetSpy },
        get: messageGetSpy,
      },
    },
  } as unknown as gmail_v1.Gmail;
  return { gmail, attachmentGetSpy, messageGetSpy };
}

async function makeClient(gmail: gmail_v1.Gmail): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = createServer({
    gmail,
    authorizedScopes: ["gmail.modify"],
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "downloads-handlers-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await Promise.all([client.close(), server.close()]);
    },
  };
}

function textOf(out: { content: Array<{ type: string; text?: string }> }): string {
  return out.content.find((c) => c.type === "text")?.text ?? "";
}

describe("download_attachment — handler-level coverage", () => {
  let tmpDir: string;
  let savedDownloadDir: string | undefined;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-dl-"));
    // The download jail check rejects any savePath outside the
    // configured download dir. Set once for the whole file (env vars
    // are process-scope so per-test mutation would race under
    // vitest's default file-parallel runner).
    savedDownloadDir = process.env.GMAIL_MCP_DOWNLOAD_DIR;
    process.env.GMAIL_MCP_DOWNLOAD_DIR = tmpDir;
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedDownloadDir === undefined) {
      delete process.env.GMAIL_MCP_DOWNLOAD_DIR;
    } else {
      process.env.GMAIL_MCP_DOWNLOAD_DIR = savedDownloadDir;
    }
  });

  it("uses the supplied filename and writes the attachment bytes to savePath", async () => {
    const { gmail, attachmentGetSpy, messageGetSpy } = makeMockGmail({
      attachmentBytes: "ATTACHMENT-PAYLOAD",
    });
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "download_attachment",
        arguments: {
          messageId: "M-1",
          attachmentId: "ATT-1",
          filename: "explicit.bin",
          savePath: tmpDir,
        },
      });
      // With filename supplied, the messages.get fallback path is skipped.
      expect(attachmentGetSpy).toHaveBeenCalledOnce();
      expect(messageGetSpy).not.toHaveBeenCalled();
      const text = textOf(out as { content: Array<{ type: string; text?: string }> });
      expect(text).toMatch(/Attachment downloaded successfully/);
      expect(text).toContain("File: explicit.bin");
      // Verify the bytes hit disk.
      const written = fs.readFileSync(path.join(tmpDir, "explicit.bin"), "utf-8");
      expect(written).toBe("ATTACHMENT-PAYLOAD");
    } finally {
      await close();
    }
  });

  it("falls back to the MIME tree's `filename` attribute when no filename is supplied", async () => {
    const { gmail, messageGetSpy } = makeMockGmail();
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "download_attachment",
        arguments: {
          messageId: "M-1",
          attachmentId: "ATT-1",
          savePath: tmpDir,
        },
      });
      // No filename -> recursive findAttachment picks up "report.pdf".
      expect(messageGetSpy).toHaveBeenCalledOnce();
      const text = textOf(out as { content: Array<{ type: string; text?: string }> });
      expect(text).toContain("File: report.pdf");
      expect(fs.existsSync(path.join(tmpDir, "report.pdf"))).toBe(true);
    } finally {
      await close();
    }
  });

  it("falls back to attachment-{id} when the MIME tree carries no filename for this attachmentId", async () => {
    // Payload exists but the matching part has body.attachmentId
    // without the optional `filename` attribute. Exercises both:
    // - the inner `part.filename || \`attachment-...\`` fallback
    // - the outer `||` that runs when findAttachment returned null/empty
    const { gmail } = makeMockGmail({
      fullMessagePayload: {
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "application/octet-stream",
            body: { attachmentId: "ATT-1", size: 4 },
          },
        ],
      },
    });
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "download_attachment",
        arguments: {
          messageId: "M-1",
          attachmentId: "ATT-1",
          savePath: tmpDir,
        },
      });
      const text = textOf(out as { content: Array<{ type: string; text?: string }> });
      expect(text).toContain("File: attachment-ATT-1");
    } finally {
      await close();
    }
  });

  it("recurses into nested parts to find the attachmentId", async () => {
    // Attachment lives one level deep inside a multipart/related.
    // Exercises the `if (part.parts)` recursion branch + the early
    // return when a child resolves the attachment.
    const { gmail } = makeMockGmail({
      fullMessagePayload: {
        mimeType: "multipart/mixed",
        parts: [
          { mimeType: "text/plain", body: { data: Buffer.from("body").toString("base64url") } },
          {
            mimeType: "multipart/related",
            parts: [
              {
                filename: "nested.png",
                mimeType: "image/png",
                body: { attachmentId: "ATT-1", size: 8 },
              },
            ],
          },
        ],
      },
    });
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "download_attachment",
        arguments: {
          messageId: "M-1",
          attachmentId: "ATT-1",
          savePath: tmpDir,
        },
      });
      const text = textOf(out as { content: Array<{ type: string; text?: string }> });
      expect(text).toContain("File: nested.png");
    } finally {
      await close();
    }
  });

  it("throws when the attachment endpoint returns no data", async () => {
    const gmail = {
      users: {
        messages: {
          attachments: { get: vi.fn(() => Promise.resolve({ data: {} })) },
          get: vi.fn(),
        },
      },
    } as unknown as gmail_v1.Gmail;
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "download_attachment",
        arguments: { messageId: "M-1", attachmentId: "ATT-1", savePath: tmpDir },
      });
      expect(out.isError).toBe(true);
      expect(textOf(out as { content: Array<{ type: string; text?: string }> })).toMatch(
        /No attachment data received/,
      );
    } finally {
      await close();
    }
  });
});
