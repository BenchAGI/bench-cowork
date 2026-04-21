---
name: wiki-capture
description: Capture the current conversation or a referenced PR as a canon draft in the BenchAGI Agent Wiki Review Queue. Calls the bench-wiki MCP's wiki_ingest tool.
---

Capture `$ARGUMENTS` as a canon draft.

If `$ARGUMENTS` is a PR reference (e.g. `#471`), the skill pulls the PR metadata via `gh pr view` and formats the canon entry.

If `$ARGUMENTS` is a freeform description, the skill uses the current conversation context as the body and infers a title from the user's summary.

All entries go through the classifier + auto-approve gate (per PR #446). Rarity defaults to `common` unless the content matches the `uncommon`+ heuristics.

Requires `/bench-login` first — the ingest endpoint needs a Bench UID for authorship attribution.
