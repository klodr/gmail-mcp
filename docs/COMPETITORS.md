# Competitors & ecosystem snapshot

_Snapshot: 2026-04-27_

## Why this page exists

Before adding a tool, we look at what the community has already built. This page is the record of that exercise: who else ships a Gmail MCP server, what they do well, what we borrow, and what we chose not to borrow.

We maintain it honestly. If a repo here has evolved or we got something wrong, open an issue or a PR.

## Method

- GitHub search for `gmail mcp` across public repositories
- [Glama.ai MCP connector directory](https://glama.ai/mcp/connectors?query=gmail)
- All forks of [GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server) (the original, and still the most-starred Gmail MCP server at 1097★)
- For each repo: language, stars, forks, last push, license, tool count, tests, CI, release discipline, unique features

Scope: 29 standalone Gmail-MCP repositories + 349 forks of the GongRzhe upstream.

## Fork lineage of klodr/gmail-mcp

The comparison table in the [README](../README.md#why-this-mcp) already covers the direct lineage:

- [GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server) — 1097★, original server, **ARCHIVED** (archived 2026-03-03; last push August 2025; 30 PRs left unmerged at archive time).
- [ArtyMcLabin/Gmail-MCP-Server](https://github.com/ArtyMcLabin/Gmail-MCP-Server) — 123★, active TypeScript port, merged long-pending community fixes.
- **[klodr/gmail-mcp](https://github.com/klodr/gmail-mcp)** — 4★, this repo. Adds the supply-chain / path-jail / review-policy layer.

The rest of this page covers the wider landscape.

## Standalone repositories

Sorted by stars, snapshot `2026-04-23`.

### Serious contenders

| Repo | Stars | Forks | Last push | Language | License | What they do well |
|---|---:|---:|---|---|---|---|
| [shinzo-labs/gmail-mcp](https://github.com/shinzo-labs/gmail-mcp) | 53 | 48 | 2025-11-25 | JavaScript | MIT | The widest Gmail API coverage in the landscape — vacation responder, delegates, S/MIME, IMAP/POP, forwarding, language, `users.watch` push notifications, full settings CRUD. ~50 tools. Changesets-based version flow. |
| [Quantum-369/Gmail-mcp-server](https://github.com/Quantum-369/Gmail-mcp-server) | 17 | 6 | 2025-07-08 | Python | Apache-2.0 | Multi-account keystore: one Gmail MCP instance handling several mailboxes with per-request `account_id` selector. |
| [Sallytion/Gmail-MCP](https://github.com/Sallytion/Gmail-MCP) | 12 | 7 | 2025-09-17 | TypeScript | — | Separate upstream root (not a fork of GongRzhe). Source of [GodotH/Easy-Gmail-MCP](https://github.com/GodotH/Easy-Gmail-MCP). IMAP/SMTP app-password auth rather than OAuth — simpler install, narrower security model. |
| [muammar-yacoob/GMail-Manager-MCP](https://github.com/muammar-yacoob/GMail-Manager-MCP) | 9 | 5 | 2025-09-12 | TypeScript | MIT | Release discipline (33 releases on npm), inbox analytics tools, AI-drafted reply suggestions, dedicated batch-label wrappers. |

### Notable POCs and experiments

| Repo | Stars | Language | Notable idea |
|---|---:|---|---|
| [vinayak-mehta/gmail-mcp](https://github.com/vinayak-mehta/gmail-mcp) | 6 | Python | Clean minimal read-only POC (3 tools). |
| [bastienchabal/gmail-mcp](https://github.com/bastienchabal/gmail-mcp) | 0 (6 forks) | Python | Ambitious feature surface: thread-aware `draft_reply` with full sender history, named-entity recognition on message bodies, calendar integration. Infra is thin. |
| [ustikya/mcp-gmail](https://github.com/ustikya/mcp-gmail) | 2 | TypeScript | First-class `reply_to_email` and `forward_email` tools (instead of reconstructing threading from `send_email`). |
| [cablate/mcp-google-gmail](https://github.com/cablate/mcp-google-gmail) | 1 | TypeScript | Published on npm; minimal tool surface. |
| [murphy360/mcp_gmail](https://github.com/murphy360/mcp_gmail) | 0 | Python | Server-side aggregation: `daily_summary`, `category_summary`, `inbox_stats` tools built for agent briefings. Home Assistant integration. |
| [meyannis/mcpgmail](https://github.com/meyannis/mcpgmail) | 0 | Python | Server-side filter enforcement via `filters.yaml` — tools are capped at the config level rather than by OAuth scope, a privacy-first angle. |
| [dhagash2310/gmail-mcp](https://github.com/dhagash2310/gmail-mcp) | 0 | Python | 23 tools including a `summarize_recent_emails` digest tool. SSE transport option alongside stdio. |
| [GodotH/Easy-Gmail-MCP](https://github.com/GodotH/Easy-Gmail-MCP) | 1 | TypeScript | Fork of Sallytion with tightened docs and Docker packaging. |

### The long tail

15 repositories with 0 or 1 stars, typically single-commit prototypes, framework demos, or class assignments. None compete on infrastructure; a few are interesting snapshots of what a given platform thought a "Gmail MCP" should look like.

<details>
<summary>Long-tail list (click to expand)</summary>

| Repo | Stars | Last push | Language | Note |
|---|---:|---|---|---|
| [HitmanLy007/gmail-mcp](https://github.com/HitmanLy007/gmail-mcp) | 1 | 2025-05-16 | JavaScript | Stale fork of shinzo-labs, no divergence visible. |
| [windsornguyen/gmail-mcp](https://github.com/windsornguyen/gmail-mcp) | 1 | 2026-01-28 | Python | Dedalus framework demo. |
| [CaptainCrouton89/maps-mcp](https://github.com/CaptainCrouton89/maps-mcp) | 1 | 2025-08-20 | TypeScript | Boilerplate covering several Google services; Gmail is one module of five. |
| [annyzhou/gmail-mcp](https://github.com/annyzhou/gmail-mcp) | 1 | 2026-01-21 | Python | Dedalus framework demo. |
| [faithk7/gmail-mcp](https://github.com/faithk7/gmail-mcp) | 0 (1 fork) | 2025-09-14 | JavaScript | Quiet fork of shinzo-labs, no published release. |
| [0x8687/mcp-gmail-v1](https://github.com/0x8687/mcp-gmail-v1) | 0 (1 fork) | 2025-07-17 | TypeScript | Wraps Composio SaaS rather than calling the Gmail API directly. |
| [XiangWanggithub/Gmail-mcp](https://github.com/XiangWanggithub/Gmail-mcp) | 0 | 2026-02-18 | Python | — |
| [victormasson21/foundation-project-mcp](https://github.com/victormasson21/foundation-project-mcp) | 0 | 2025-12-07 | TypeScript | Personal agent with Notion style guide. |
| [SolonaBot/gmail-mcp](https://github.com/SolonaBot/gmail-mcp) | 0 | 2026-02-09 | TypeScript | Single-commit start, drafts/reply marked "coming soon". |
| [RichardFelix999/Google-Service-MCP](https://github.com/RichardFelix999/Google-Service-MCP) | 0 | 2025-10-02 | TypeScript | Unattributed copy of `CaptainCrouton89/maps-mcp`. |
| [PranavMishra28/gmail-mcp](https://github.com/PranavMishra28/gmail-mcp) | 0 | 2025-10-12 | JavaScript | Mono-tool demo (`send_email` via app password). |
| [nk900600/gmail-mcp](https://github.com/nk900600/gmail-mcp) | 0 | 2025-07-24 | JavaScript | Shinzo-labs derivative. |
| [martingaston/mcp-gmail](https://github.com/martingaston/mcp-gmail) | 0 | 2026-01-09 | Python | Experimental, 3 tools. |
| [fred-drake/gmail-mcp](https://github.com/fred-drake/gmail-mcp) | 0 | 2026-01-07 | Python | FastMCP scaffold, 5 tools. |
| [fernandezdiegoh/gmail-mcp](https://github.com/fernandezdiegoh/gmail-mcp) | 0 | 2026-03-25 | Python | Minimalist, multi-account via environment variables. |
| [dedalus-labs/gmail-mcp](https://github.com/dedalus-labs/gmail-mcp) | 0 | 2026-02-28 | Python | Dedalus framework demo. |

</details>

## GongRzhe forks

349 forks in total, the vast majority dormant. Beyond **ArtyMcLabin** (which is our own intermediate), only three forks have any meaningful code divergence from upstream:

| Fork | Stars | Commits ahead | What they changed |
|---|---:|---:|---|
| [oO/Gmail-MCP-Server](https://github.com/oO/Gmail-MCP-Server) | 1 | 1 | Refactor to a "Gateway + Skills" pattern — collapses the 24 atomic tools into 3 polymorphic ones (`google_mail`, `google_settings`, `google_calendar`) with an `action` parameter. Reduces the `ListTools` catalog size by ~87%. |
| [alexknowshtml/Gmail-MCP-Server](https://github.com/alexknowshtml/Gmail-MCP-Server) | 1 | 4 | Fixes a `list_filters` bug: the Gmail API returns `response.data.filter` (singular), not `.filters`. This fix is already carried in `klodr/gmail-mcp` via the ArtyMcLabin chain. |
| [Abdullah-MotiWala/Gmail-MCP-Server](https://github.com/Abdullah-MotiWala/Gmail-MCP-Server) | 1 | 2 | Personal adaptation for TypingMind — narrow-purpose. |

310+ forks show `ahead_by=0`: default clones never modified. Nothing to harvest there.

## Ideas we borrowed

All of these end up tracked in [ROADMAP.md](./ROADMAP.md) with attribution to their source.

- **Gmail Settings API completeness** — vacation responder, forwarding, IMAP/POP settings, delegates, S/MIME, language. Inspired by [shinzo-labs/gmail-mcp](https://github.com/shinzo-labs/gmail-mcp).
- **`users.watch` / `users.stop` push notifications** — lets an agent wait on Gmail Pub/Sub events instead of polling. Inspired by [shinzo-labs/gmail-mcp](https://github.com/shinzo-labs/gmail-mcp).
- **First-class `reply_to_email` / `forward_email` tools** — rather than asking the agent to reconstruct `In-Reply-To` and `References` headers via `send_email`. Inspired by [ustikya/mcp-gmail](https://github.com/ustikya/mcp-gmail) and [fernandezdiegoh/gmail-mcp](https://github.com/fernandezdiegoh/gmail-mcp).

## Ideas we looked at and chose not to adopt

Not value judgments — scope decisions.

- **"Gateway + Skills" tool collapse** ([oO/Gmail-MCP-Server](https://github.com/oO/Gmail-MCP-Server)). Smaller `ListTools` payload, but it violates MCP's self-describing tools principle: the LLM loses semantic autocomplete on sub-actions and has to be told which `action: ...` strings exist via external documentation. Modern LLMs handle 25–30 tools without degradation, so the catalog size isn't our bottleneck.
- **Multi-account keystore with per-request selection** ([Quantum-369/Gmail-mcp-server](https://github.com/Quantum-369/Gmail-mcp-server), [fernandezdiegoh/gmail-mcp](https://github.com/fernandezdiegoh/gmail-mcp)). A single-tenant OAuth store keeps the blast radius of a prompt injection narrow. Users who need several accounts can run the server twice with different config paths.
- **Server-side digest tools** (`summarize_inbox`, `daily_summary`, `category_summary` — [murphy360/mcp_gmail](https://github.com/murphy360/mcp_gmail), [dhagash2310/gmail-mcp](https://github.com/dhagash2310/gmail-mcp)). LLMs already summarize raw headers well. An opinionated server-side digest couples us to a specific use-case and shifts logic away from the place it's easiest to iterate on.
- **Filter enforcement via `filters.yaml`** ([meyannis/mcpgmail](https://github.com/meyannis/mcpgmail)). Overlaps with our OAuth-scope filter (the tool list is already filtered at startup based on granted scopes) and our recipient pairing gate (planned in ROADMAP). Revisit if a concrete policy use-case emerges that neither of those addresses.
- **HTTP / SSE transport alongside stdio** ([dhagash2310/gmail-mcp](https://github.com/dhagash2310/gmail-mcp)). The MCP spec is converging on streamable-HTTP; we'll revisit when the SDK makes it idiomatic.
- **Inbox analytics tools** (`inbox_stats`, top-senders distribution — [muammar-yacoob/GMail-Manager-MCP](https://github.com/muammar-yacoob/GMail-Manager-MCP)). Same reasoning as digest tools: the LLM composes this from `search_emails` when it actually needs it.
- **Dedicated batch-label wrappers** (`batch_apply_labels`, `batch_remove_labels` — [muammar-yacoob/GMail-Manager-MCP](https://github.com/muammar-yacoob/GMail-Manager-MCP)). Covered by the generic `batch_modify_emails`. Syntactic sugar with no semantic gain.

## Where klodr/gmail-mcp sits

- **Not the largest catalog** — shinzo-labs covers more Gmail Settings endpoints; we're closing that gap (see ROADMAP).
- **Not the most stars** — GongRzhe has 1097 (archived). First tagged version April 2026.
- **The only implementation in the landscape** combining:
  - CodeQL Advanced + Socket Security + OpenSSF Scorecard + Snyk on every PR
  - Sigstore keyless signing + SLSA in-toto attestations + SPDX/CycloneDX SBOMs on every release
  - npm provenance statements
  - 631 vitest tests + fast-check property-based fuzz suite + hardening-specific test file
  - Path-jail defenses (`GMAIL_MCP_ATTACHMENT_DIR`, `GMAIL_MCP_DOWNLOAD_DIR` with `O_NOFOLLOW` + post-`mkdir` realpath re-verification)
  - OAuth scope filtering at startup — tool list is filtered before the LLM ever sees it
  - Cryptographic MIME boundaries, CRLF sanitization on both email-assembly paths
  - `.coderabbit.yaml` assertive-profile gate that every PR must pass

The bet: agent-platform operators care more about what an MCP can't be coerced into doing than about how many Gmail endpoints it wraps. Coverage gaps close in a release cycle; a hardening backbone takes longer to build.

## Help keep this page honest

- Missing a repository? Open a PR against `docs/COMPETITORS.md`.
- Disagree with a verdict or think we mischaracterised your project? Open an issue — we'll fix it or reply in-thread.
- If your work is cited here and you'd like the attribution adjusted (or the link to your repo swapped for a personal page), ping [@klodr](https://github.com/klodr) directly.

This snapshot reflects the state of the ecosystem on `2026-04-27`. Stars, last-push dates, and forks move; the tradeoffs usually don't.
