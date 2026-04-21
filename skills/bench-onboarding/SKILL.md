---
name: bench-onboarding
description: First-run orientation for a new BenchAGI teammate or pilot customer. Walks through what the Bench Crew is, who the agents are, and how to use them. Use when a new user just installed the plugin or is asking "what is this" / "how do I use this".
---

# Bench Onboarding (Tier D)

First-run orientation for someone who just installed the Bench Cowork plugin.

## When to trigger

- Right after `/bench-login` completes for the first time (the login command can point at this)
- When the user asks "what is this", "how do I use this", "what can you do"
- When the user sees `@aurelius` or `@bailey` mentioned and asks who they are

## Onboarding script

Deliver this in 3 short beats. Don't dump it all at once — pace it.

### Beat 1 — What this is

> You just installed **Bench Cowork** — Tier D of the BenchAGI harness. It adds 7 specialist agents and 7 skills to your Claude Code session, plus MCP servers that read and write BenchAGI canon (shared knowledge) and canvas tiles (the launch-readiness dashboard).
>
> Everything talks to benchagi.com over HTTPS. No local daemons, no background processes. You can uninstall cleanly at any time.

### Beat 2 — Meet the agents

> The Bench Crew:
>
> - **Aurelius** — coordinator, drafts external email, runs fleet coordination
> - **Bailey** — your personal-space agent (Gmail triage, reminders, notes)
> - **Cole** — morning briefing + sales-pipeline anomalies
> - **Sage** — customer-success voice (calm, specific, professional)
> - **Ember** — internal field-ops rally voice (WoW-style; never customer-facing)
> - **Piper** — product + UX research (PRDs, call summaries)
> - **Kestrel-Coder** — engineering (code review, implementation)
>
> Invoke any with `@<name>` or `/<name>`, e.g. `/aurelius draft a follow-up to Jim` or `@bailey triage my inbox`.

### Beat 3 — What to try first

> Three starter tasks:
>
> 1. `/bench-login <your-email>` — if you haven't already.
> 2. `@bailey hi` — say hi to your personal agent. She'll ask what you'd like help with.
> 3. `/wiki-capture` on a recent decision or PR — feed the agent canon so future sessions know about it.
>
> Things to know:
>
> - Every outbound email goes through `aurelius-email` and carries a named human approver. You'll always review before it sends.
> - Agents refuse harmful or out-of-charter requests. That's a feature.
> - If something's missing or wrong, `/wiki-capture` a canon entry explaining the gap — the next session inherits it.

## Handoff

After this onboarding, the user will likely want to:
- **Triage their inbox** → hand off to **Bailey**
- **Draft a follow-up** → **Aurelius** (via `aurelius-email`)
- **Review a PR** → **Kestrel-Coder** (with `review` skill)
- **Understand pipeline state** → **Cole**

## Adaptive notes

- If the user is a pilot customer (non-BenchAGI staff), emphasize Sage. Skip Ember and internal rally references.
- If the user is a BenchAGI teammate, mention Ember and Storm XP.
- If the user mentions they're an engineer, lead with Kestrel-Coder + the engineering skills (review, security-review, simplify, hammer-anvil).
