/**
 * End-to-end coverage for the download_attachment handler in
 * src/tools/downloads.ts. download_email is covered through
 * test/download-email.test.ts (format-specific assertions on the
 * email-export helpers); this file targets download_attachment's
 * branches that the helper-level suite cannot reach.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { gmail_v1 } from "googleapis";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { resetJailDirectoryCache } from "../src/utl.js";

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

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-dl-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Vitest's `vi.stubEnv` is scope-managed: the env mutation is
  // tracked per test and `vi.unstubAllEnvs()` in afterEach cleanly
  // reverts every stub regardless of order. This avoids the
  // file-parallel race of bare `process.env.X = ...` because each
  // worker only sees its own stubbed value within the test.
  beforeEach(() => {
    vi.stubEnv("GMAIL_MCP_DOWNLOAD_DIR", tmpDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

/**
 * Gmail mock that behaves like the live API on the point that broke
 * `download_attachment`: every `messages.get` re-issues a FRESH
 * `attachmentId` for each part (`<partId>-r<read#>`), and every one of
 * those ids stays valid for `attachments.get`. `attachments.get` only
 * returns `{ size, data }`, like the real endpoint.
 */
interface FakePart {
  partId: string;
  filename?: string;
  mimeType?: string;
  content: string;
  /** Put the body in `body.data` (no attachmentId), as Gmail may for small parts. */
  inlineBody?: boolean;
  headers?: Array<{ name: string; value: string }>;
}

function makeRotatingGmail(
  parts: FakePart[],
  opts: { html?: string; attachmentGetError?: number; noPayload?: boolean } = {},
): {
  gmail: gmail_v1.Gmail;
  attachmentGetSpy: ReturnType<typeof vi.fn>;
  messageGetSpy: ReturnType<typeof vi.fn>;
} {
  let reads = 0;
  const byPartId = new Map(parts.map((p) => [p.partId, p]));
  const messageGetSpy = vi.fn(() => {
    const read = ++reads;
    const htmlParts = opts.html
      ? [
          {
            partId: "0",
            mimeType: "text/html",
            body: { data: Buffer.from(opts.html).toString("base64url"), size: opts.html.length },
          },
        ]
      : [];
    const payload = {
      partId: "",
      mimeType: "multipart/mixed",
      parts: [
        ...htmlParts,
        ...parts.map((p) => ({
          partId: p.partId,
          filename: p.filename ?? "",
          mimeType: p.mimeType ?? "application/pdf",
          headers: p.headers ?? [],
          body: p.inlineBody
            ? {
                data: Buffer.from(p.content).toString("base64url"),
                size: Buffer.byteLength(p.content),
              }
            : { attachmentId: `${p.partId}-r${read}`, size: Buffer.byteLength(p.content) },
        })),
      ],
    };
    return Promise.resolve({
      data: opts.noPayload ? { id: "M-1" } : { id: "M-1", threadId: "T-1", payload },
    });
  });
  const attachmentGetSpy = vi.fn((params: { id: string }) => {
    if (opts.attachmentGetError !== undefined) {
      const error = new Error("Backend Error") as Error & { code: number };
      error.code = opts.attachmentGetError;
      return Promise.reject(error);
    }
    const part = byPartId.get(params.id.split("-r")[0] ?? "");
    if (!part) return Promise.reject(new Error(`unknown attachment id ${params.id}`));
    return Promise.resolve({
      data: {
        size: Buffer.byteLength(part.content),
        data: Buffer.from(part.content).toString("base64url"),
      },
    });
  });
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

/** The id an earlier `read_email` (read #0) would have handed the caller. */
const idFromEarlierRead = (partId: string) => `${partId}-r0`;

describe("download_attachment — original filename with re-issued attachment ids", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-dl-names-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // The jail root is cached per process; reset it so this block's
  // tmpDir (not the previous block's) is the active jail.
  beforeEach(() => {
    vi.stubEnv("GMAIL_MCP_DOWNLOAD_DIR", tmpDir);
    resetJailDirectoryCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetJailDirectoryCache();
  });

  async function download(
    gmail: gmail_v1.Gmail,
    attachmentId: string,
    savePath: string,
  ): Promise<{ text: string; isError?: boolean }> {
    const { client, close } = await makeClient(gmail);
    try {
      const out = (await client.callTool({
        name: "download_attachment",
        arguments: { messageId: "M-1", attachmentId, savePath },
      })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
      return { text: textOf(out), isError: out.isError };
    } finally {
      await close();
    }
  }

  it("keeps the original name although the id no longer matches the fresh read (regression)", async () => {
    // Before the fix, the handler compared the caller's id with the ids
    // of a NEW messages.get, never matched, and saved the file as
    // `attachment-<first 24 chars of the id>`.
    const { gmail, attachmentGetSpy } = makeRotatingGmail([
      { partId: "1", filename: "plus.pdf", content: "PDF-PLUS-164560" },
      { partId: "2", filename: "world elite.pdf", content: "PDF-WORLD-ELITE-45626" },
    ]);
    const dir = path.join(tmpDir, "regression");
    const out = await download(gmail, idFromEarlierRead("2"), dir);
    expect(out.isError).toBeFalsy();
    expect(out.text).toContain("File: world elite.pdf");
    expect(fs.readFileSync(path.join(dir, "world elite.pdf"), "utf8")).toBe(
      "PDF-WORLD-ELITE-45626",
    );
    // Sizes are unique: no extra attachment fetch was needed.
    expect(attachmentGetSpy).toHaveBeenCalledOnce();
  });

  it("disambiguates same-size attachments with different names by comparing bytes", async () => {
    // Mirrors the live message that surfaced the bug: two PDFs of
    // exactly 47374 bytes each, different names and contents.
    const { gmail, attachmentGetSpy } = makeRotatingGmail([
      { partId: "7", filename: "initialFile - 183121.pdf", content: "AAAA-same-size" },
      { partId: "8", filename: "initialFile - 183024.pdf", content: "BBBB-same-size" },
    ]);
    const dir = path.join(tmpDir, "tie");
    const out = await download(gmail, idFromEarlierRead("8"), dir);
    expect(out.text).toContain("File: initialFile - 183024.pdf");
    expect(fs.readFileSync(path.join(dir, "initialFile - 183024.pdf"), "utf8")).toBe(
      "BBBB-same-size",
    );
    // 1 download + 2 candidate probes (fresh ids from the second read).
    expect(attachmentGetSpy).toHaveBeenCalledTimes(3);
    expect(attachmentGetSpy.mock.calls.slice(1).map((c) => (c[0] as { id: string }).id)).toEqual([
      "7-r1",
      "8-r1",
    ]);
  });

  it("uses the shared name without probing when same-size parts all carry the same name", async () => {
    const { gmail, attachmentGetSpy } = makeRotatingGmail([
      { partId: "1", filename: "scan.pdf", content: "1111" },
      { partId: "2", filename: "scan.pdf", content: "2222" },
    ]);
    const out = await download(gmail, idFromEarlierRead("2"), path.join(tmpDir, "same-name"));
    expect(out.text).toContain("File: scan.pdf");
    expect(attachmentGetSpy).toHaveBeenCalledOnce();
  });

  it("picks the first name in MIME order when same-size parts have identical bytes", async () => {
    const { gmail } = makeRotatingGmail([
      { partId: "1", filename: "first.pdf", content: "identical" },
      { partId: "2", filename: "second.pdf", content: "identical" },
    ]);
    const out = await download(gmail, idFromEarlierRead("2"), path.join(tmpDir, "identical"));
    expect(out.text).toContain("File: first.pdf");
  });

  it("compares against a candidate whose body Gmail inlined in the payload", async () => {
    const { gmail, attachmentGetSpy } = makeRotatingGmail([
      { partId: "1", filename: "inline-copy.txt", content: "abcd", inlineBody: true },
      { partId: "2", filename: "wanted.txt", content: "wxyz" },
    ]);
    const out = await download(gmail, idFromEarlierRead("2"), path.join(tmpDir, "inline-body"));
    expect(out.text).toContain("File: wanted.txt");
    // 1 download + 1 probe (the inlined candidate needs no fetch).
    expect(attachmentGetSpy).toHaveBeenCalledTimes(2);
  });

  it("falls back to attachment-{id} when no part has the downloaded size", async () => {
    const { gmail, attachmentGetSpy } = makeRotatingGmail([
      { partId: "1", filename: "a.pdf", content: "12345" },
    ]);
    // The downloaded bytes (3) match no part of the fresh read (5).
    attachmentGetSpy.mockImplementationOnce(() =>
      Promise.resolve({ data: { size: 3, data: Buffer.from("xyz").toString("base64url") } }),
    );
    const out = await download(gmail, "9-r0", path.join(tmpDir, "no-match"));
    expect(out.text).toContain("File: attachment-9-r0");
  });

  it("falls back to attachment-{id} when every same-size candidate differs byte-wise", async () => {
    const { gmail, attachmentGetSpy } = makeRotatingGmail([
      { partId: "1", filename: "a.pdf", content: "aaa" },
      { partId: "2", filename: "b.pdf", content: "bbb" },
    ]);
    // Same size as both parts, but neither part holds these bytes.
    attachmentGetSpy.mockImplementationOnce(() =>
      Promise.resolve({ data: { size: 3, data: Buffer.from("zzz").toString("base64url") } }),
    );
    const out = await download(gmail, "X-r0", path.join(tmpDir, "no-byte-match"));
    expect(out.text).toContain("File: attachment-X-r0");
  });

  it("falls back to attachment-{id} when the byte-matched part has no filename", async () => {
    const { gmail } = makeRotatingGmail([
      { partId: "1", filename: "a.pdf", content: "aaa" },
      { partId: "2", content: "bbb" },
    ]);
    const out = await download(gmail, idFromEarlierRead("2"), path.join(tmpDir, "unnamed-match"));
    expect(out.text).toContain("File: attachment-2-r0");
  });

  it("saves under the jail root when savePath is omitted", async () => {
    const { gmail } = makeRotatingGmail([
      { partId: "1", filename: "root-single.pdf", content: "ROOT" },
    ]);
    const { client, close } = await makeClient(gmail);
    try {
      const out = await client.callTool({
        name: "download_attachment",
        arguments: { messageId: "M-1", attachmentId: idFromEarlierRead("1") },
      });
      expect(textOf(out as { content: Array<{ type: string; text?: string }> })).toContain(
        "File: root-single.pdf",
      );
      expect(fs.readFileSync(path.join(tmpDir, "root-single.pdf"), "utf8")).toBe("ROOT");
    } finally {
      await close();
    }
  });

  it("falls back to attachment-{id} when the message payload is missing", async () => {
    const { gmail } = makeRotatingGmail([{ partId: "1", filename: "a.pdf", content: "aaa" }], {
      noPayload: true,
    });
    const out = await download(gmail, idFromEarlierRead("1"), path.join(tmpDir, "no-payload"));
    expect(out.text).toContain("File: attachment-1-r0");
  });
});
