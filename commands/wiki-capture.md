---
name: wiki-capture
description: Capture the current conversation or a referenced PR as a canon draft in the BenchAGI Agent Wiki Review Queue. Calls the bench-wiki MCP's wiki_draft tool.
---

Capture `$ARGUMENTS` as a canon draft.

If `$ARGUMENTS` is a PR reference (e.g. `#471`), the skill pulls the PR metadata via `gh pr view` and formats the canon entry.

If `$ARGUMENTS` is a freeform description, the skill uses the current conversation context as the body and infers a title from the user's summary.

Drafts land in the admin review queue with `approvalStatus: 'draft'`; a super-admin promotes them to platform canon. Rarity defaults to `common` unless the content matches the `uncommon`+ heuristics — the reviewer can override at promotion time.

Requires `/bench-login` first — the `wiki_draft` endpoint is member-auth and needs a Bench UID for authorship attribution. The separate `wiki_ingest` tool is for bulk-syncing a local vault into your per-user shard; this command always calls `wiki_draft` for single conversation-born captures.
