---
name: forge-report
description: File a harness failure as a Forge diagnostics ticket via the bench-forge MCP — no GitHub account needed. Trigger when `benchagi doctor` output shows failing checks, when the user pastes a harness error/runbook worth escalating, or on "file this as a ticket", "report this to Bench", "forge report", "send this to the Forge". Offer it proactively when diagnostics output in the conversation looks report-worthy.
---

# Forge Report

Files harness diagnostics from a tenant Claude Code session as a **Forge ticket**. The
ticket lands in Firestore and syncs server-side to a GitHub issue in the Forge repo —
the tenant never needs a GitHub account. This is the intended escalation path when a
harness problem can't be fixed locally.

**Requires `/bench-login` first.** The `bench-forge` MCP carries your cowork token; the
server stamps your tenant from `auth.instanceId`. Expired tokens are auto-refreshed by
the bridge — see Edge cases.

## When to use

- `benchagi doctor` (or any harness self-check) shows failing checks you can't resolve.
- The user pastes a harness error, crash log, or diagnostics runbook worth escalating.
- A session hits a Bench-side bug (broken endpoint, auth loop, MCP bridge failure) that
  the BenchAGI team should see.

When doctor output or a pasted failure looks report-worthy, **offer** to file it —
don't submit without the user's go-ahead, and never auto-file on every failed check.

## Workflow

### 1. Gather context

Collect what the triaging engineer will need:

```bash
benchagi --version 2>/dev/null; openclaw --version 2>/dev/null; claude --version 2>/dev/null
sw_vers -productVersion 2>/dev/null || uname -sr
```

- The failing output itself (doctor checks, error text, stack trace).
- A runbook file if the user points at one (e.g. `~/Downloads/diagnostics.md`) — read it
  and use it as the ticket body.
- What was attempted already, if the conversation shows it.

### 2. Choose severity

| Severity | When |
|---|---|
| `sev-1` | Harness fully down — agent can't operate, no workaround |
| `sev-2` | A capability is broken (auth loop, MCP bridge dead, doctor check failing) but the harness limps along |
| `sev-3` | Degraded or cosmetic — works with a workaround |
| `question` | Not a failure — a how-do-I or is-this-expected ask |

When unsure between two, pick the lower severity and say so in the body.

### 3. Call `forge_submit_diagnostics`

Load the tool schema if deferred:

```
ToolSearch(query: "select:mcp__bench-forge__forge_submit_diagnostics", max_results: 1)
```

Then call:

```
mcp__bench-forge__forge_submit_diagnostics({
  severity: "<sev-1|sev-2|sev-3|question>",
  subject: "<short, scannable — becomes the GitHub issue title>",
  body: "<markdown: failing output + runbook + what was tried>",
  reporterContext: {
    machine: "<hostname / model / OS version>",
    benchCliVersion: "<benchagi --version or 'not installed'>",
    gatewayVersion: "<openclaw --version or 'not installed'>",
    doctorChecks: "<failing check names, if doctor was run>"
  }
})
```

Notes:
- `body` is markdown, **max 120 KB** — trim giant logs to the failing sections and say
  what was cut.
- Do NOT send an `instanceId` — tenant binding comes from auth server-side.
- **201** `{ ticketId, status: "queued" }` → new ticket, proceed to polling.
- **200** `{ ticketId, status, issueUrl? }` → identical content was already filed
  (dedupe by content hash); report the existing ticket instead of re-submitting.

### 4. Poll `forge_ticket_status`

The GitHub sync is async. Poll about **3 times, ~2 seconds apart**:

```
mcp__bench-forge__forge_ticket_status({ id: "<ticketId>" })
```

- `syncStatus: "synced"` → stop; you have `issueNumber` + `issueUrl`.
- `syncStatus: "failed"` → stop; report `failureReason` (the ticket is still recorded —
  the team sees it in Firestore even when GitHub sync fails).
- Still `"pending"` after ~3 polls → stop polling; the ticket is queued and will sync.

### 5. Report back

> Filed Forge ticket `<ticketId>` (severity `<severity>`).
> GitHub issue: `<issueUrl>` — or "sync still pending; re-check later with
> `forge_ticket_status`" / "sync failed: `<failureReason>` (ticket is recorded)".

## Edge cases

- **401 `COWORK_BAD_TOKEN`**: the bench-http-bridge auto-refreshes the token against
  `/cowork/auth/refresh` and retries once — you usually never see this. If the call
  still fails with `COWORK_REFRESH_EXPIRED` or `COWORK_REFRESH_CHAIN_TOO_OLD`, the
  refresh window is exhausted: ask the user to re-run `/bench-login`.
- **429**: rate limit is 10 tickets per user per 24h. Tell the user which existing
  ticket likely covers the issue, or wait.
- **413 / body too large**: trim the body under 120 KB — keep the failing checks and the
  last ~100 lines of any log, note the truncation.
- **Duplicate (200)**: don't file variants of the same failure to force a new ticket;
  surface the existing `ticketId`/`issueUrl` instead.
