---
name: forge-report
description: File a harness failure as a Forge diagnostics ticket (Firestore → GitHub issue, no GitHub account needed). Calls the bench-forge MCP's forge_submit_diagnostics tool and polls forge_ticket_status for the issue URL.
---

File `$ARGUMENTS` as a Forge diagnostics ticket.

If `$ARGUMENTS` is a file path (e.g. `~/Downloads/diagnostics.md`), read it and use it as the runbook body. If it's a freeform description, gather the failing output from the current conversation (doctor checks, error text) plus harness versions, and build the body from that. If empty, look for the most recent harness failure in the conversation and confirm with the user before filing.

Severity mapping: harness fully down → `sev-1`; a capability broken but harness limping → `sev-2`; degraded/cosmetic → `sev-3`; not a failure → `question`.

After the POST returns a `ticketId`, poll `forge_ticket_status` ~3 times at ~2s intervals and report the `ticketId` plus the GitHub `issueUrl` (or "sync pending" / the `failureReason`). A 200 response means identical content was already filed — report the existing ticket, don't re-submit.

Requires `/bench-login` first — the endpoint is cowork-auth and stamps the tenant from `auth.instanceId` server-side. Expired tokens are auto-refreshed by the bench-http-bridge; if refresh fails with `COWORK_REFRESH_EXPIRED` / `COWORK_REFRESH_CHAIN_TOO_OLD`, re-run `/bench-login`. See the forge-report skill for the full workflow.
