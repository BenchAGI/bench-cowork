---
name: wiki-capture
description: Capture a merged PR, a conversation summary, or a decision as a canon draft in the BenchAGI Agent Wiki Review Queue. Tier D version — uses the bench-wiki MCP instead of the monorepo's scripts/wiki-capture/. Trigger on "capture PR #", "wiki capture", "feed this to the wiki", "add to agent knowledge", "why doesn't the agent know about this".
---

# Wiki Capture (Tier D)

Drafts canon entries into the Agent Wiki Review Queue so durable knowledge feeds agent context. This is the **Tier D** version — it calls the `bench-wiki` MCP's `wiki_ingest` tool directly, without needing the monorepo checked out locally.

**Requires `/bench-login` first.** The MCP call carries your Bench UID for authorship attribution + the classifier + auto-approve gate (per PR #446).

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

When unsure, stay at `common` — the auto-approve gate still lets it through, and humans can promote rarity later via the review queue.

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

### 4. Call `bench-wiki.wiki_ingest`

Load the MCP tool schema if deferred:

```
ToolSearch(query: "select:mcp__bench-wiki__wiki_ingest", max_results: 1)
```

Then call:

```
mcp__bench-wiki__wiki_ingest({
  title: "<short, title-cased, under 80 chars>",
  body: "<markdown; see body template below>",
  kind: "canon",
  agent: "<agent>",
  rarity: "<rarity>"
})
```

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

The `wiki_ingest` response includes the new slug. Tell the user:

> Captured as canon entry `<slug>` (rarity: `<rarity>`). It'll be visible at https://benchagi.com/wiki/canon once the auto-approve gate processes it (seconds).

## Edge cases

- **Token missing/expired**: the MCP call returns 401 `COWORK_BAD_TOKEN`. Ask the user to run `/bench-login`.
- **Rate limited**: returns 429. Tell the user to wait a minute and retry.
- **Duplicate title**: the ingest endpoint dedups by hash; if body is identical, action is `unchanged` — that's fine, no retry needed.

## Tier D vs Tier A/B

- Tier A/B users running in the monorepo can use the original `scripts/wiki-capture/forward.ts` script. Tier D users go through this MCP call.
- Both paths land in the same Firestore collection (`wikiEntries/{slug}`) and the same review queue.
- Tier D can't do the `backtrace` rollup (needs repo access); that stays a Tier A/B operator action.
