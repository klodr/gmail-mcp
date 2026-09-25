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
import { buildZipArchive } from "../src/tools/downloads.js";
import zlib from "node:zlib";

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

  it("fails instead of using the fallback name when the probe cap hides the match", async () => {
    // 11 same-size parts with distinct names and bytes; the requested one
    // is the 11th, beyond the 10-candidate comparison limit.
    const parts = Array.from({ length: 11 }, (_, index) => ({
      partId: String(index + 1),
      filename: `statement-${String(index + 1).padStart(2, "0")}.pdf`,
      content: `STATEMENT-${String(index + 1).padStart(2, "0")}`,
    }));
    const { gmail, attachmentGetSpy } = makeRotatingGmail(parts);
    const dir = path.join(tmpDir, "probe-cap");
    const out = await download(gmail, idFromEarlierRead("11"), dir);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("11 attachments share its size and only 10 can be compared");
    expect(out.text).toContain("Pass `filename` explicitly");
    // 1 download + exactly 10 probes, and nothing written.
    expect(attachmentGetSpy).toHaveBeenCalledTimes(11);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("still resolves a same-size attachment found within the probe cap", async () => {
    const parts = Array.from({ length: 11 }, (_, index) => ({
      partId: String(index + 1),
      filename: `statement-${String(index + 1).padStart(2, "0")}.pdf`,
      content: `STATEMENT-${String(index + 1).padStart(2, "0")}`,
    }));
    const { gmail } = makeRotatingGmail(parts);
    const out = await download(gmail, idFromEarlierRead("3"), path.join(tmpDir, "probe-hit"));
    expect(out.text).toContain("File: statement-03.pdf");
  });

  it("falls back to attachment-{id} when the message payload is missing", async () => {
    const { gmail } = makeRotatingGmail([{ partId: "1", filename: "a.pdf", content: "aaa" }], {
      noPayload: true,
    });
    const out = await download(gmail, idFromEarlierRead("1"), path.join(tmpDir, "no-payload"));
    expect(out.text).toContain("File: attachment-1-r0");
  });
});

/**
 * Minimal, independent ZIP reader (central directory → local header →
 * raw inflate via node:zlib). Deliberately NOT fflate's `unzipSync`,
 * which collects entries in a plain object and so cannot return an
 * entry named `__proto__`; it also cross-checks fflate's output with a
 * second implementation.
 */
function readZip(archive: Buffer): Array<{ name: string; utf8: boolean; data: Buffer }> {
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  const entries: Array<{ name: string; utf8: boolean; data: Buffer }> = [];
  for (let index = 0; index < count; index++) {
    expect(archive.readUInt32LE(offset)).toBe(0x02_01_4b_50);
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localHeader = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const dataStart =
      localHeader +
      30 +
      archive.readUInt16LE(localHeader + 26) +
      archive.readUInt16LE(localHeader + 28);
    const raw = archive.subarray(dataStart, dataStart + compressedSize);
    entries.push({
      name,
      utf8: (flags & 0x08_00) !== 0,
      data: method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

interface BulkResult {
  status: string;
  messageId: string;
  mode: "files" | "zip";
  directory: string;
  zipPath?: string;
  zipSize?: number;
  files: Array<{ filename: string; path?: string; size: number; mimeType: string }>;
  skipped: Array<{ filename: string; mimeType: string; size: number; reason: string }>;
}

describe("download_all_attachments", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-dl-all-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.stubEnv("GMAIL_MCP_DOWNLOAD_DIR", tmpDir);
    resetJailDirectoryCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetJailDirectoryCache();
  });

  async function downloadAll(
    gmail: gmail_v1.Gmail,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError?: boolean; result?: BulkResult }> {
    const { client, close } = await makeClient(gmail);
    try {
      const out = (await client.callTool({
        name: "download_all_attachments",
        arguments: { messageId: "M-1", ...args },
      })) as {
        content: Array<{ type: string; text?: string }>;
        isError?: boolean;
        structuredContent?: unknown;
      };
      return {
        text: textOf(out),
        isError: out.isError,
        result: out.structuredContent as BulkResult | undefined,
      };
    } finally {
      await close();
    }
  }

  const SIGNATURE_HTML = '<p>Regards</p><img src="cid:image001.jpg@01DC2D8F.1D7B6A60">';
  const signatureLogo: FakePart = {
    partId: "0.1",
    filename: "image001.jpg",
    mimeType: "image/jpeg",
    content: "JPEG-LOGO",
    headers: [
      { name: "Content-ID", value: "<image001.jpg@01DC2D8F.1D7B6A60>" },
      { name: "Content-Disposition", value: 'inline; filename="image001.jpg"' },
    ],
  };

  it("writes every attachment under its original name and skips cid: inline images", async () => {
    const { gmail, attachmentGetSpy, messageGetSpy } = makeRotatingGmail(
      [
        signatureLogo,
        { partId: "1", filename: "plus.pdf", content: "PDF-PLUS" },
        { partId: "2", filename: "world elite.pdf", content: "PDF-WORLD-ELITE" },
        {
          partId: "5",
          filename: "initialFile - 2026-09-24T182929.192.pdf",
          content: "PDF-INITIAL",
        },
      ],
      { html: SIGNATURE_HTML },
    );
    const dir = path.join(tmpDir, "files");
    const out = await downloadAll(gmail, { savePath: dir });
    expect(out.isError).toBeFalsy();
    expect(messageGetSpy).toHaveBeenCalledOnce();
    // Ids come from the single read: no id matching, one fetch per kept part.
    expect(attachmentGetSpy.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual([
      "1-r1",
      "2-r1",
      "5-r1",
    ]);
    expect(fs.readdirSync(dir).sort()).toEqual([
      "initialFile - 2026-09-24T182929.192.pdf",
      "plus.pdf",
      "world elite.pdf",
    ]);
    expect(fs.readFileSync(path.join(dir, "world elite.pdf"), "utf8")).toBe("PDF-WORLD-ELITE");
    const realDir = fs.realpathSync(dir);
    expect(out.result).toEqual({
      status: "saved",
      messageId: "M-1",
      mode: "files",
      directory: realDir,
      files: [
        {
          filename: "plus.pdf",
          path: path.join(realDir, "plus.pdf"),
          size: 8,
          mimeType: "application/pdf",
        },
        {
          filename: "world elite.pdf",
          path: path.join(realDir, "world elite.pdf"),
          size: 15,
          mimeType: "application/pdf",
        },
        {
          filename: "initialFile - 2026-09-24T182929.192.pdf",
          path: path.join(realDir, "initialFile - 2026-09-24T182929.192.pdf"),
          size: 11,
          mimeType: "application/pdf",
        },
      ],
      skipped: [{ filename: "image001.jpg", mimeType: "image/jpeg", size: 9, reason: "inline" }],
    });
    expect(out.text).toContain('"mode": "files"');
  });

  it("includes inline images when includeInline is true", async () => {
    const { gmail } = makeRotatingGmail(
      [signatureLogo, { partId: "1", filename: "plus.pdf", content: "PDF-PLUS" }],
      { html: SIGNATURE_HTML },
    );
    const dir = path.join(tmpDir, "with-inline");
    const out = await downloadAll(gmail, { savePath: dir, includeInline: true });
    expect(out.result?.skipped).toEqual([]);
    expect(fs.readdirSync(dir).sort()).toEqual(["image001.jpg", "plus.pdf"]);
  });

  it("keeps a Content-ID part the HTML never references (Gmail lists it as an attachment)", async () => {
    const { gmail } = makeRotatingGmail([{ ...signatureLogo, filename: "photo.jpg" }], {
      html: "<p>no image references</p>",
    });
    const out = await downloadAll(gmail, { savePath: path.join(tmpDir, "unreferenced") });
    expect(out.result?.files.map((f) => f.filename)).toEqual(["photo.jpg"]);
  });

  it("de-duplicates names (case-insensitively) and sanitizes hostile ones", async () => {
    const { gmail } = makeRotatingGmail([
      { partId: "1", filename: "report.pdf", content: "one" },
      { partId: "2", filename: "report.pdf", content: "two" },
      { partId: "3", filename: "REPORT.pdf", content: "three" },
      { partId: "4", filename: "../../etc/passwd", content: "hostile" },
      { partId: "5", content: "no name" },
    ]);
    const dir = path.join(tmpDir, "dedupe");
    const out = await downloadAll(gmail, { savePath: dir });
    expect(out.result?.files.map((f) => f.filename)).toEqual([
      "report.pdf",
      "report (2).pdf",
      "REPORT (3).pdf",
      "_.._etc_passwd",
      "attachment-5",
    ]);
    expect(fs.readFileSync(path.join(dir, "report (2).pdf"), "utf8")).toBe("two");
    expect(fs.readFileSync(path.join(dir, "_.._etc_passwd"), "utf8")).toBe("hostile");
  });

  it("never overwrites a file already on disk (O_EXCL suffix) and reports the real name", async () => {
    const dir = path.join(tmpDir, "collision");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "plus.pdf"), "PRE-EXISTING");
    const { gmail } = makeRotatingGmail([{ partId: "1", filename: "plus.pdf", content: "NEW" }]);
    const out = await downloadAll(gmail, { savePath: dir });
    expect(out.result?.files[0]?.filename).toBe("plus (1).pdf");
    expect(fs.readFileSync(path.join(dir, "plus.pdf"), "utf8")).toBe("PRE-EXISTING");
    expect(fs.readFileSync(path.join(dir, "plus (1).pdf"), "utf8")).toBe("NEW");
  });

  it("decodes named parts whose body Gmail inlined, without an attachments.get call", async () => {
    const { gmail, attachmentGetSpy } = makeRotatingGmail([
      {
        partId: "1",
        filename: "note.txt",
        mimeType: "text/plain",
        content: "hi",
        inlineBody: true,
      },
    ]);
    const dir = path.join(tmpDir, "inline-body");
    await downloadAll(gmail, { savePath: dir });
    expect(attachmentGetSpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(dir, "note.txt"), "utf8")).toBe("hi");
  });

  it("bundles everything into one ZIP that keeps the original (UTF-8) names", async () => {
    const { gmail } = makeRotatingGmail(
      [
        signatureLogo,
        { partId: "1", filename: "plus.pdf", content: "PDF-PLUS" },
        { partId: "2", filename: "résumé.pdf", content: "PDF-RESUME" },
        { partId: "3", filename: "plus.pdf", content: "PDF-PLUS-BIS" },
        { partId: "4", filename: "__proto__", content: "PROTO" },
      ],
      { html: SIGNATURE_HTML },
    );
    const dir = path.join(tmpDir, "zip");
    const out = await downloadAll(gmail, { savePath: dir, zip: true });
    expect(out.isError).toBeFalsy();
    // Only the archive is written — no loose files.
    expect(fs.readdirSync(dir)).toEqual(["M-1-attachments.zip"]);
    const zipPath = path.join(fs.realpathSync(dir), "M-1-attachments.zip");
    expect(out.result?.mode).toBe("zip");
    expect(out.result?.zipPath).toBe(zipPath);
    // Read the archive once (no stat-then-read race, CodeQL js/file-system-race).
    const zipBytes = fs.readFileSync(zipPath);
    expect(out.result?.zipSize).toBe(zipBytes.length);
    expect(out.result?.files.map((f) => f.filename)).toEqual([
      "plus.pdf",
      "résumé.pdf",
      "plus (2).pdf",
      "__proto__",
    ]);
    expect(out.result?.files.every((f) => f.path === undefined)).toBe(true);
    expect(out.result?.skipped.map((s) => s.filename)).toEqual(["image001.jpg"]);

    const entries = readZip(zipBytes);
    expect(entries.map((e) => [e.name, e.data.toString("utf8"), e.utf8])).toEqual([
      ["plus.pdf", "PDF-PLUS", false],
      // Non-ASCII names carry the ZIP UTF-8 flag (general purpose bit 11).
      ["résumé.pdf", "PDF-RESUME", true],
      ["plus (2).pdf", "PDF-PLUS-BIS", false],
      // An attachment literally named `__proto__` must survive (object-keyed
      // zip builders silently drop it through the prototype setter).
      ["__proto__", "PROTO", false],
    ]);
  });

  it("sanitizes a caller-supplied zipFilename, appends .zip, and keeps it inside the jail", async () => {
    const { gmail } = makeRotatingGmail([{ partId: "1", filename: "a.pdf", content: "A" }]);
    const dir = path.join(tmpDir, "zip-name");
    const out = await downloadAll(gmail, {
      savePath: dir,
      zip: true,
      zipFilename: "../../Relevés bancaires",
    });
    expect(path.basename(out.result?.zipPath ?? "")).toBe("_.._Relevés bancaires.zip");
    expect(fs.readdirSync(dir)).toEqual(["_.._Relevés bancaires.zip"]);
  });

  it("does not double the extension of a zipFilename that already ends in .ZIP, and suffixes on collision", async () => {
    const dir = path.join(tmpDir, "zip-collision");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "bundle.ZIP"), "old");
    const { gmail } = makeRotatingGmail([{ partId: "1", filename: "a.pdf", content: "A" }]);
    const out = await downloadAll(gmail, { savePath: dir, zip: true, zipFilename: "bundle.ZIP" });
    expect(path.basename(out.result?.zipPath ?? "")).toBe("bundle (1).ZIP");
    expect(fs.readFileSync(path.join(dir, "bundle.ZIP"), "utf8")).toBe("old");
  });

  it("refuses a savePath outside the download jail", async () => {
    const { gmail, messageGetSpy } = makeRotatingGmail([
      { partId: "1", filename: "a.pdf", content: "A" },
    ]);
    const out = await downloadAll(gmail, { savePath: os.tmpdir(), zip: true });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/outside the allowed download directory/);
    expect(messageGetSpy).not.toHaveBeenCalled();
  });

  it("defaults savePath to the jail root", async () => {
    const { gmail } = makeRotatingGmail([
      { partId: "1", filename: "root-default.pdf", content: "R" },
    ]);
    const out = await downloadAll(gmail, {});
    expect(out.result?.directory).toBe(fs.realpathSync(tmpDir));
    expect(fs.existsSync(path.join(tmpDir, "root-default.pdf"))).toBe(true);
  });

  it("errors when the message has no attachment at all", async () => {
    const { gmail } = makeRotatingGmail([], { html: "<p>hello</p>" });
    const out = await downloadAll(gmail, { savePath: path.join(tmpDir, "none") });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Message M-1 has no attachments to download");
    expect(out.text).not.toContain("inline part");
  });

  it("errors with a hint when only inline images are present", async () => {
    const { gmail } = makeRotatingGmail([signatureLogo], { html: SIGNATURE_HTML });
    const out = await downloadAll(gmail, { savePath: path.join(tmpDir, "only-inline") });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("1 inline part(s) skipped; pass includeInline: true");
  });

  it("errors when the message payload is missing", async () => {
    const { gmail } = makeRotatingGmail([], { noPayload: true });
    const out = await downloadAll(gmail, { savePath: path.join(tmpDir, "no-payload") });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("has no attachments to download");
  });

  it("refuses messages with more than 100 attachments", async () => {
    const parts = Array.from({ length: 101 }, (_, index) => ({
      partId: String(index + 1),
      filename: `f${index}.bin`,
      content: "x",
    }));
    const { gmail, attachmentGetSpy } = makeRotatingGmail(parts);
    const out = await downloadAll(gmail, { savePath: path.join(tmpDir, "too-many") });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("has 101 attachments");
    expect(attachmentGetSpy).not.toHaveBeenCalled();
  });

  it("writes nothing when a Gmail fetch fails, and surfaces the HTTP status", async () => {
    const { gmail } = makeRotatingGmail(
      [
        { partId: "1", filename: "a.pdf", content: "A" },
        { partId: "2", filename: "b.pdf", content: "B" },
      ],
      { attachmentGetError: 503 },
    );
    const dir = path.join(tmpDir, "fetch-error");
    const out = await downloadAll(gmail, { savePath: dir, zip: true });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Failed to download attachments (HTTP 503)");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("reports a plain error without HTTP status when the attachment body is empty", async () => {
    const { gmail, attachmentGetSpy } = makeRotatingGmail([
      { partId: "1", filename: "a.pdf", content: "A" },
    ]);
    attachmentGetSpy.mockImplementationOnce(() => Promise.resolve({ data: { size: 0 } }));
    const out = await downloadAll(gmail, { savePath: path.join(tmpDir, "empty-body") });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Failed to download attachments: No attachment data received");
  });
});

describe("buildZipArchive", () => {
  it("produces a valid, empty archive for no entries", () => {
    expect(readZip(buildZipArchive([]))).toEqual([]);
  });

  it("round-trips binary content byte-for-byte", () => {
    const binary = Buffer.from(Uint8Array.from({ length: 70_000 }, (_, i) => (i * 7919) % 256));
    const entries = readZip(
      buildZipArchive([
        { name: "a.bin", data: binary },
        { name: "b.txt", data: Buffer.from("hello") },
      ]),
    );
    expect(entries.map((e) => e.name)).toEqual(["a.bin", "b.txt"]);
    expect(entries[0]?.data.equals(binary)).toBe(true);
    expect(entries[1]?.data.toString("utf8")).toBe("hello");
  });
});
