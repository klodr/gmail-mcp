// Production read-only smoke-test for gmail-mcp.
//
// Spawns `node dist/index.js` as a child stdio process, connects via
// the MCP SDK's StdioClientTransport, and walks a minimum viable
// read path: list labels → search inbox → read first message →
// list inbox threads → get first thread. Fails on any tool that
// crashes or comes back with `isError`.
//
// Env requirements (all optional except credentials, which the
// server itself reads from ~/.gmail-mcp/ by default):
//
//   GMAIL_MCP_OAUTH_KEYS_PATH   - override client_id/client_secret path
//   GMAIL_MCP_CREDENTIALS_PATH  - override refresh-token path
//
// The OAuth token MUST carry at least `gmail.readonly`. The server's
// scope filter hides write tools when that is all it has, so this
// script exercises only read tools regardless.
//
// Usage:
//   npm run build && node scripts/prod-readonly-test.mjs

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = resolve(__dirname, "..", "dist", "index.js");

const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER_ENTRY],
  stderr: "inherit",
});

const client = new Client({ name: "gmail-mcp-smoke", version: "0.0.0" });
await client.connect(transport);

const CALL_TIMEOUT_MS = 30_000;

const results = [];
async function run(label, name, args = {}) {
  process.stdout.write(`▶ ${label.padEnd(50)} `);
  try {
    const res = await client.callTool(
      { name, arguments: args },
      undefined, // resultSchema — let the SDK default apply
      { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
    );
    const text = res.content?.[0]?.text ?? "";
    if (res.isError) {
      const tag = text.includes("401")
        ? "🔒 401"
        : text.includes("403")
          ? "🔒 403"
          : text.includes("404")
            ? "⚠️  404"
            : "❌ ERR";
      console.log(`${tag} — ${text.slice(0, 80)}`);
      results.push({ tool: label, status: "error", detail: text });
      return null;
    }
    console.log("✅");
    results.push({ tool: label, status: "ok" });
    // Tool responses are text-first; many also carry structuredContent.
    if (res.structuredContent) return res.structuredContent;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (err) {
    console.log(`💥 ${err.message}`);
    results.push({ tool: label, status: "exception", detail: err.message });
    return null;
  }
}

console.log("\n=== LABELS ===");
await run("list_email_labels", "list_email_labels");

console.log("\n=== SEARCH ===");
const search = await run("search_emails (in:inbox, 3)", "search_emails", {
  query: "in:inbox",
  maxResults: 3,
});

// search_emails returns either a raw array or a { messages: [...] } envelope
// depending on middleware path. Handle both.
const firstMsg = Array.isArray(search) ? search[0] : (search?.messages?.[0] ?? search?.[0]);
const firstMsgId = firstMsg?.id ?? firstMsg?.messageId;
console.log(`   → using messageId = ${firstMsgId ?? "(none)"}`);

if (firstMsgId) {
  // `format` values must match ReadEmailSchema: "full" | "summary" |
  // "headers_only". "txt" / "json" are not schema values.
  await run("read_email (full)", "read_email", {
    messageId: firstMsgId,
    format: "full",
  });
  await run("read_email (summary)", "read_email", {
    messageId: firstMsgId,
    format: "summary",
  });
  await run("read_email (headers_only)", "read_email", {
    messageId: firstMsgId,
    format: "headers_only",
  });
}

console.log("\n=== THREADS ===");
const threads = await run("list_inbox_threads (3)", "list_inbox_threads", {
  maxResults: 3,
});
const firstThread = Array.isArray(threads) ? threads[0] : (threads?.threads?.[0] ?? threads?.[0]);
const firstThreadId = firstThread?.id ?? firstThread?.threadId;
console.log(`   → using threadId = ${firstThreadId ?? "(none)"}`);

if (firstThreadId) {
  await run("get_thread", "get_thread", { threadId: firstThreadId });
}

console.log("\n=== INBOX+THREADS COMBINED ===");
await run("get_inbox_with_threads (3)", "get_inbox_with_threads", {
  maxResults: 3,
});

console.log("\n========== SUMMARY ==========");
const ok = results.filter((r) => r.status === "ok").length;
const errs = results.filter((r) => r.status !== "ok").length;
console.log(`✅ OK:           ${ok}`);
console.log(`❌ Errors:       ${errs}`);
if (errs) {
  console.log("\nFailures:");
  for (const r of results.filter((x) => x.status !== "ok")) {
    console.log(`  - ${r.tool}: ${r.detail?.slice(0, 150) ?? ""}`);
  }
}

await client.close();
process.exit(errs > 0 ? 1 : 0);
