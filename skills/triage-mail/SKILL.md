---
name: triage-mail
description: 'Run the daily multi-account Gmail triage workflow via the bench-mail MCP: inspect connected inboxes, classify last-day unread inbox threads, apply Triaged/<bucket> labels, create review-only Gmail drafts for the highest-priority replies, and commit a daily digest branch. Use for natural-language asks like "triage my email", "morning email run", "run inbox triage", "check my inboxes for the day", or "daily mail triage" when the user wants the full roll-up across accounts. Do not use for one-off drafting, a single reply, or generic email-writing requests; route those to aurelius-email instead. Requires bench-mail MCP in mcp.json and at least one Gmail account connected at /admin/settings/integrations/bench-mail.'
---

# triage-mail

Daily multi-account email triage. This is the operating loop that turns unread inboxes into labels, review-only drafts, and one digest branch the user can scan.

## Why this exists

Cory has multiple Gmail accounts connected through bench-mail. Without this skill, daily triage requires pasting the loop from `packages/bench-mail/LOCAL-LOOP-RECIPE.md` into every Claude Code session. This skill makes that morning flow callable while keeping the same approval and transparency posture as `aurelius-email`.

## Canonical Context

- **Aurelius** is the Bench Crew coordinator for cross-team follow-ups, external correspondence drafts, fleet coordination, canon authoring, and morning digest work.
- Every outbound Bench AI email draft must carry provenance: prepared-by agent, named human approver, and the public AI Transparency Audit Log.
- Drafts created by this skill are review-only Gmail drafts. The user reviews and sends manually from Gmail.

## Prerequisites

- bench-mail MCP wired into the calling Claude Code session (per `packages/bench-mail/LOCAL-DEV.md`; `mcp.json` points at the bench-mail stdio binary).
- At least one Gmail account connected at `/admin/settings/integrations/bench-mail` in the running `apps/web`.
- Working tree at the BenchAGI monorepo root. The digest branch is created in this repo.

If `mcp__bench-mail__list_accounts` is not available as a tool, abort before any side effects and tell the user:

> bench-mail MCP not detected. Wire it into your Claude Code per `packages/bench-mail/LOCAL-DEV.md`, restart Claude Code so the tool list refreshes, then try `/triage-mail` again.

If `mcp__bench-mail__list_accounts` errors with `NO_ACCOUNTS_CONNECTED`, or returns an empty `accounts` array, abort before any side effects and tell the user:

> No Gmail accounts connected for this Bench UID. Connect at least one at `/admin/settings/integrations/bench-mail` and try again.

## Run Context

Before drafting, resolve these values:

- `preparedBy`: default `Aurelius`.
- `approverName`: default `Cory Shelton`, unless the user explicitly names another human approver for this run.
- `approvedAt`: current timestamp in `America/Denver`, formatted like `Apr 25, 2026, 08:15 AM MDT`.
- `runDate`: current date in `America/Denver`, formatted `YYYY-MM-DD`.

Because Gmail drafts are reviewed manually, `approverName` is the required named human for the final-send footer. The human accepts, edits, or deletes that footer when they send from Gmail; the MCP does not approve or send anything on its own.

## Cofounders To Always Escalate

Use this explicit contact allowlist first:

- Jim Johnson (`jim@benchagi.com`)
- Jory Allen (`jory@benchagi.com`)

If a thread appears to involve a new cofounder or leadership contact not on this list, classify it by the rules below and add a `possible cofounder/contact-list drift` note to the digest. Do not silently treat unstated names as cofounders.

## Workflow

### Step 0 - preflight the repo and run state

Do this before Gmail labels or drafts:

1. Confirm the current `cwd` is the BenchAGI monorepo root with `git rev-parse --show-toplevel`.
2. Confirm the working tree is clean enough to switch branches. If unrelated local changes are present, stop before Gmail side effects and ask the user for a clean worktree or permission to create a separate worktree.
3. Fetch `origin main`.
4. Set `branchName` to `triage/<runDate>` and `digestPath` to `daily-triage/<runDate>.md`.
5. If `branchName` exists locally, switch to it.
6. Else if `origin/<branchName>` exists, create a local tracking branch from it.
7. Else create `branchName` from `origin/main`, not from the current feature branch.
8. If `digestPath` already exists, parse it for existing `(account, thread_id, draft_id)` rows and use those as the same-day idempotency ledger.

If branch creation, branch checkout, or digest parsing fails, abort before Gmail side effects and report the blocker. Never force-push or overwrite a same-day branch.

### Step 1 - discover connected accounts

Call `mcp__bench-mail__list_accounts` with no arguments. Expect:

```json
{
  "accounts": [
    { "email": "cory@gocarbonblack.com", "scopes": ["..."], "expiresAt": "..." },
    { "email": "cory@benchagi.com", "scopes": ["..."], "expiresAt": "..." }
  ]
}
```

If there are no accounts, use the abort behavior from Prerequisites and do not create labels, drafts, commits, or pushes.

### Step 2 - per-account triage

Process each account independently. A failure in one account must not cascade into another account.

For each account, with `account_email` set to that account's email:

1. `mcp__bench-mail__search_threads(account_email, "newer_than:1d in:inbox -is:read", 50)`.
2. If exactly 50 threads are returned, add a digest note that the account may be truncated and needs pagination support.
3. For each thread, call `mcp__bench-mail__get_thread(account_email, thread_id)` to capture sender, subject, snippet, recipients, and any available body text.
4. Classify into exactly one bucket using the priority order below.
5. Apply `Triaged/<bucket>` via `mcp__bench-mail__apply_label`. Create labels lazily with `mcp__bench-mail__create_label`; treat already-existing labels as success.
6. Draft replies for important threads using the drafting rules below.

If any per-account tool call errors with `TOKEN_NOT_FOUND` or `TOKEN_REFRESH_FAILED`, mark that account as skipped, log it under "Notes / anomalies", and continue with the next account.

If `apply_label` fails for one thread, log the account, thread, bucket, and error, then continue classifying and drafting remaining threads. If Gmail reports a label-limit error, stop creating/applying labels for that account, continue classification/drafting, and log which threads were left unlabeled.

### Step 3 - classify threads

Buckets are mutually exclusive by priority:

1. `cofounders` - From, To, Cc, or body references a contact in the cofounder allowlist above.
2. `customer-or-pilot` - The thread includes explicit evidence of a BenchAGI customer, pilot, deal, onboarding, implementation, support issue, proposal, or tenant rollout. A known customer/pilot domain only counts if the domain comes from an in-repo/wiki allowlist, the current thread text, or another explicit source inspected during this run.
3. `external-or-investor` - Partner, investor, vendor, press, advisor, integration provider, recruiting, or other business contact that is not already cofounder/customer/pilot.
4. `personal-or-noise` - Newsletters, automated alerts, notifications, personal mail, and anything non-actionable or not confidently covered above.

Do not rely on unstated memory for "known customer/pilot domain". When evidence is ambiguous, choose the lower-risk bucket (`external-or-investor` before `customer-or-pilot`, `personal-or-noise` for automated/non-actionable mail) and add a short rationale in the digest.

## Drafting Rules

Create at most about five new drafts per run unless the user explicitly asks for more.

Always consider `cofounders` and `customer-or-pilot` threads first. Consider `external-or-investor` or `personal-or-noise` only when the thread clearly requests action, such as a question, deadline, scheduling request, payment issue, legal/finance item, or operational blocker.

Before calling `mcp__bench-mail__create_draft`, build an idempotency key:

```text
<account_email>::<thread_id>
```

- If the same-day digest already contains a draft for that key, do not create another draft; report the existing draft ID.
- If bench-mail exposes a draft-search/list tool in the current session, check for an existing draft for the same thread before creating a new one.
- If there is no digest ledger and no draft-search/list tool, ask before re-drafting a thread that looks previously handled.

Draft with:

```text
mcp__bench-mail__create_draft(account_email, { to, subject, body, htmlBody, in_reply_to })
```

Both `body` and `htmlBody` should be supplied when the tool supports them. Follow the `aurelius-email` template shape: direct body copy, BenchAGI brand chrome in HTML, prepared-by agent, named human approver, timestamp, and transparency links.

Plain-text drafts MUST end with this readable footer:

```text
--
Prepared by Aurelius (Bench Crew, BenchAGI)
Approved by Cory Shelton @ <approvedAt>

AI Transparency Audit Log: https://benchagi.com/ai-transparency
Get BenchAGI.com: https://benchagi.com?utm_source=aurelius-email&utm_medium=email&utm_campaign=aurelius-signature
```

Replace `Aurelius`, `Cory Shelton`, and `<approvedAt>` with the resolved run context. Never leave placeholders like `[link]` in a draft.

## Step 4 - aggregated digest

Write or update the digest at `daily-triage/<runDate>.md` on `branchName`:

```markdown
# Email Triage - <runDate>

**Total inboxes triaged:** <count>
**Total threads triaged:** <sum across all accounts>
**Drafts created this run:** <count>
**Branch:** `triage/<runDate>`

## Bucket counts (aggregated)

- Cofounders: <n>
- Customer/Pilot: <n>
- External/Investor: <n>
- Personal/Noise: <n>

## Per-account breakdown

| Account | Cofounders | Customer/Pilot | External/Investor | Personal/Noise | Drafts | Skipped/Error |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| <email> | <n> | <n> | <n> | <n> | <n> | <status> |

## Important threads (drafted)

| Account | Thread ID | Sender | Subject | Bucket | Gmail link | Draft ID | Suggested action |
| --- | --- | --- | --- | --- | --- | --- | --- |

Use account-aware Gmail links when possible. Do not hardcode `/mail/u/0/` for every account unless bench-mail provides no account index; prefer a link format tied to `account_email` or note that the link may need the matching Gmail account selected.

## Deferred (no draft)

| Account | Thread ID | Sender | Subject | Bucket | Why deferred |
| --- | --- | --- | --- | --- | --- |

## Notes / anomalies

- Token failures, label failures, truncation at 50 threads, ambiguous classifications, possible contact-list drift, duplicate-draft skips, git issues, or anything the user should see.
```

Commit message: `triage: daily digest for <runDate>`.

Push `branchName` after commit. If the commit is a no-op, say so and push only if the branch has not been pushed. If push is rejected, do not force-push; report the local branch and exact Git error.

Do not open a PR. The user reviews drafts in Gmail and the digest branch directly.

## State Changes And Reversibility

This skill can make these state changes:

- Gmail labels: `Triaged/<bucket>` labels may be created and applied. Reversible by removing the label from a thread or deleting the label in Gmail.
- Gmail drafts: review-only drafts may be created. Reversible by deleting the Gmail draft.
- Git branch: `triage/<runDate>` may be created or updated. Reversible by deleting the local/remote branch.
- Digest file: `daily-triage/<runDate>.md` may be written. Reversible by editing or reverting the digest commit.
- Git commit/push: the digest commit may be pushed. Reversible by a follow-up commit or branch deletion; never force-push unless the user explicitly asks.

Record enough IDs in the digest to undo each state change: account, thread ID, label, draft ID, branch, commit SHA.

## Hard Rules

- Every Gmail action takes an explicit `account_email`. There is no global "current account" in bench-mail.
- Drafts only. Never call any send tool. The bench-mail server should not hold `gmail.send`; if a send-capable tool appears, do not use it from this skill.
- Never create labels or drafts until repo preflight and account discovery have succeeded.
- Never invent recipient emails, customer domains, approvers, or audit links.
- Never duplicate same-day drafts for the same `(account_email, thread_id)` when a digest ledger or draft-search tool can identify the existing draft.
- Never base the digest branch on the current feature branch; use `origin/main` for first creation and the existing same-day branch for resumed runs.

## What To Return To The User

Return a short summary:

- N inboxes triaged, M threads classified, K drafts created, D duplicate drafts skipped.
- Branch name and digest path.
- Per-account counts in a small table.
- Notes / anomalies, especially skipped accounts, label failures, truncation, ambiguous customer/pilot evidence, or git push problems.

End by reminding the user: drafts are in Gmail for manual review and send; this skill does not send mail.

## Out Of Scope

- Actually sending drafts. The user approves and sends in Gmail.
- Running on a schedule. That remains `LOCAL-LOOP-RECIPE.md` territory (manual paste, `/loop`, or launchd).
- Calendar triage. That is a future `triage-cal` skill once `bench-cal` ships.
