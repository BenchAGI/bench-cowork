---
name: wiki-capture
description: Capture a merged PR, a conversation summary, or a decision as a canon draft in the BenchAGI Agent Wiki Review Queue. Tier D version — uses the bench-wiki MCP instead of the monorepo's scripts/wiki-capture/. Trigger on "capture PR #", "wiki capture", "feed this to the wiki", "add to agent knowledge", "why doesn't the agent know about this".
---

# Wiki Capture (Tier D)

Drafts canon entries into the Agent Wiki Review Queue so durable knowledge feeds agent context. This is the **Tier D** version — it calls the `bench-wiki` MCP's `wiki_draft` tool directly, without needing the monorepo checked out locally.

**Requires `/bench-login` first.** The MCP call carries your Bench UID for authorship attribution; the draft lands with `approvalStatus: 'draft'` until an admin reviews and promotes it. (The separate `wiki_ingest` tool is for bulk-syncing a local vault into your per-user shard at `users/{uid}/wikiEntries/{slug}` — different use case; this skill calls `wiki_draft` for single conversation-born captures.)

## When to use

- A PR just merged and you want an agent-readable capability entry.
- A conversation surfaced a durable insight — a new decision, a pattern, a gotcha.
- You want to make something easier for future sessions to recall than scrolling Slack or digging through git log.

## Workflow

### 1. Gather the content

If the user pointed at a PR (`#471`), fetch its metadata:

```bash
gh pr view 471 --json title,body,mergedAt,files,author
```

If the user gave a freeform description, use the current conversation context.

### 2. Choose rarity

Rarity controls who sees the entry and how it's surfaced. Default to `common`. Bump up only when the entry is durable and broadly useful:

| Rarity | When | Example |
|---|---|---|
| `common` | Individual PR capture, implementation note | "PR #471 — added retry logic to upload worker" |
| `uncommon` | Pattern emerging across multiple PRs, a team practice locking in | "We use ADR format for reversible architecture calls" |
| `rare` | Foundational decision, canon-worthy | "All outbound customer email routes through aurelius-email" |
| `epic` | Org-level commitment, multi-quarter impact | "Harness tiers A-D committed 2026-04-19" |
| `legendary` | Reserved for once-a-year landmarks | Initial charter, first-customer win |

When unsure, stay at `common` — it keeps review queue triage lightweight, and humans can promote rarity later via the review queue.

### 3. Choose agent attribution

Who's the voice this entry belongs to?

| Agent | Use for |
|---|---|
| `aurelius` | Coordination, fleet decisions, external comms patterns |
| `bailey` | Personal-space patterns, Gmail/triage, user preferences |
| `sage` | Customer-success patterns, pilot learnings |
| `cole` | Pipeline anomalies, stage-transition insights |
| `ember` | Field-ops rituals, Storm/XP mechanics |
| `piper` | UX/design-system canon, PRD patterns |
| `kestrel-coder` | Engineering decisions, refactor notes, ADRs |

If genuinely multi-agent (e.g. a platform-wide decision), use `aerie` — the collective canon owner.

### 4. Call `bench-wiki.wiki_draft`

Load the MCP tool schema if deferred:

```
ToolSearch(query: "select:mcp__bench-wiki__wiki_draft", max_results: 1)
```

The payload is **flat** (not wrapped). The server generates the slug (`draft-<epoch>-<hash8>`) — don't compute it on the client. Call:

```
mcp__bench-wiki__wiki_draft({
  title: "<short, title-cased, under 80 chars>",
  markdown: "<markdown body; see template below>",
  kind: "canon",
  agent: "<agent>",
  rarity: "<rarity>"
})
```

Notes:
- `title`, `markdown`, `kind`, `agent`, `rarity` are all **required**.
- `kind` is a strict subset: `canon | synthesis | dream` only (no `consolidation | protocol | sop` at draft tier — those go through super-admin ingest).
- `agent` must be one of: `aurelius`, `bailey`, `sage`, `cole`, `ember`, `piper`, `kestrel-coder`, `aerie`.
- **Do not send `instanceId`** in the payload — the server rejects it with a 400 and derives tenant scoping from `auth.instanceId` instead. Entries created by members inside a tenant are automatically scoped to that tenant; BenchAGI-master entries (null instanceId) come from members with no tenant binding.
- The doc always lands with `approvalStatus: 'draft'` — there's no auto-approval path on this surface. Admin review promotes it.
- Max 512 KB utf-8 per `markdown`.
- `authorUid` / `authorEmail` on the payload are ignored; they come from the auth context.

### 5. Body template

```markdown
## Context
<why this matters; the scenario or PR that prompted this>

## What happened / what we decided
<the actual fact or pattern; specific, concrete>

## How to apply
<when future agents or humans should recall this; concrete trigger conditions>

## Sources
- PR #<N> (if applicable)
- Conversation date: YYYY-MM-DD
- Relevant canon: <other slug if related>
```

### 6. Report the slug back

The `wiki_draft` response looks like:

```json
{
  "slug": "draft-1745280000000-a1b2c3d4",
  "reviewUrl": "/admin/settings/agent-wiki/review?slug=draft-1745280000000-a1b2c3d4"
}
```

Read `slug` and `reviewUrl` and tell the user:

> Captured as canon draft `<slug>` (rarity: `<rarity>`, agent: `<agent>`). It's queued for admin review at `https://benchagi.com<reviewUrl>` — it won't appear in `/wiki/canon` until a super-admin promotes it.

Drafts don't auto-approve on this surface (unlike the super-admin ingest path). Surface the review URL so the user knows where to go.

## Edge cases

- **Token missing/expired**: the MCP call returns 401 `COWORK_BAD_TOKEN`. Ask the user to run `/bench-login` (and remember to export `BENCH_COWORK_TOKEN` to the shell env — `/bench-login` writes the config file but doesn't auto-export).
- **Rate limited**: returns 429. Tell the user to wait a minute and retry.
- **Validation failure**: a 400 response includes `{ error, field? }` — the `field` names which payload property was bad (title / markdown / kind / agent / rarity / instanceId). A 413 means `markdown` exceeded 512 KB.
- **Duplicate captures**: exact same-content retries by the same UID within 24h return the original slug with `deduped: true`. Different content still creates a fresh server-generated draft slug. Don't retry on success unless you are recovering from an unknown client-side failure.

## Tier D vs Tier A/B

- Tier A/B users running in the monorepo can use `scripts/wiki-capture/forward.ts`, which routes by flag:
  - `--pr <N>` → super-admin `/api/v1/wiki/ingest` (X-API-Key, platform canon).
  - `--title "<...>" --body-file <path>` → cowork-auth `/api/v1/wiki/draft` (the same endpoint this MCP tool hits, just from the script side). Reads `~/.claude/config/bench-cowork.json` for the JWT.
- Tier D users (this skill) call `wiki_draft` directly — same endpoint, no monorepo needed. The validation rules and field defaults below are identical between the two paths since they hit the same route.
- Bulk-ingest path (`wiki_ingest`) lands in the per-user shard `users/{uid}/wikiEntries/{slug}`. Single-capture (`wiki_draft`) lands in platform `wikiEntries/{slug}` with `approvalStatus: 'draft'`. Reviewer explicitly promotes either to approved platform canon.
- Tier D can't do the `backtrace` rollup (needs repo access); that stays a Tier A/B operator action.

## Envelope shape vs `forward.ts` (no normalization across surfaces)

`wiki_draft` and `forward.ts` write to the same Firestore collection but **do not share an envelope contract**:

- `forward.ts` (Tier A/B) sends a structured `frontmatter` JSON object on the ingest envelope (camelCase fields like `capturedBy`, `prNumber`, `mergedAt`); the markdown body is plain prose. See `scripts/wiki-capture/lib/markdown-builder.ts` in the monorepo.
- `wiki_draft` (this skill) accepts only `{title, markdown, kind, agent, rarity}` — **no `frontmatter` field**. The server rejects unknown fields. Whatever metadata the entry needs (PR refs, dates, sources, verbatim quotes) goes inline in the markdown body.

**Don't try to reformat existing drafts to match `forward.ts`.** The `/api/v1/wiki/draft` route is POST-only; no PUT/PATCH endpoint exists for content edits. Agent voices differ — Aurelius writes legal-track summaries with verbatim quotes; Kestrel-Coder writes structured PR captures with H2 sections. Both are valid canon at this tier. Reviewers normalize via the admin UI on promotion; mechanical reformatting is not a goal.

If you find yourself wanting to "fix" an existing draft's frontmatter, the right move is to (a) ask Cory whether the substance is correct, and (b) if a re-capture is warranted, reject the current draft via the admin UI and call `wiki_draft` again with the corrected body.
