# Bench Cowork — agents + skills for Claude Code

**Tier D** of the BenchAGI harness ladder. Install in 60 seconds. No OpenClaw required.

## What this gives you

- **7 agent personalities** as Claude Code subagents: Aurelius, Ember, Bailey, Cole, Piper, Kestrel-Coder, Sage
- **Skills**: `aurelius-email`, `triage-mail`, `wiki-capture`, `hammer-anvil`, `simplify`, `customize-experience`, `review`, `security-review`, `bench-onboarding`, `forge-report`
- **Slash commands**: `/aurelius`, `/ember`, `/bailey`, `/cole`, `/piper`, `/sage`, `/wiki-capture`, `/bench-login`, `/forge-report`
- **MCP servers**: `bench-wiki` (canon read/write), `bench-canvas` (tile updates + drift), `bench-slack` (optional), `bench-mail` (multi-account Gmail triage), `bench-chassis` (API-key tenant bridge), `bench-deals` (deal + pipeline tools), `bench-forge` (diagnostics → Forge tickets)
- **Draft manifest**: `bench-excalidraw` remains in `mcp/` but is not registered until `/excalidraw/*` routes land
- **Hook**: Amendment 10 enforcement — PRs touching canvas-tracked code paths must update the tile

All powered by benchagi.com over HTTPS. No local daemons, no fs.watch, no launchd.

## Install (60 seconds)

```bash
# In any Claude Code session
/plugin marketplace add BenchAGI/bench-cowork
/plugin install bench-cowork@bench-cowork

# Authenticate (opens browser)
/bench-login your-email@domain.com
```

That's it. Try:

```bash
/aurelius can you follow up with the JC pilot team?
/triage-mail
/wiki-capture PR #471
```

## Harness tier map

| Tier | Install cost | Who |
|------|--------------|-----|
| A | Full monorepo + OpenClaw | Cory (power user) |
| B | OpenClaw personal | Teammates with capable Macs |
| C | Cloud-hosted OpenClaw | Web-first / low-spec users |
| **D (here)** | **Claude Code + plugin** | **Anyone — 60 sec onboard** |

## Upgrade from D → B

Install OpenClaw. The plugin auto-detects and routes canon writes to your local vault (which `wiki-mirror` then syncs to the API) instead of going API-first. Same skills, same agents, offline-capable.

```bash
brew tap benchagi/tap
brew install benchagi/tap/openclaw
openclaw init --instance-id <your-instance>
# Plugin now hybrid-routes automatically
```

## Cowork MCP vs `@openclaw/slack`

These are **complementary, not competing**. `@openclaw/slack` is the gateway-side Slack
channel plugin — it lives in an OpenClaw install (Tier A/B) and gives the *gateway* a
Slack presence. The cowork MCP servers here (`bench-slack`, `bench-wiki`, `bench-forge`, …)
are the **intended tenant route**: a Claude Code session authenticated with a cowork JWT
talks to benchagi.com, which enforces tenant binding (`auth.instanceId`), billing, and
per-tenant bot tokens server-side. Tenants without an OpenClaw install — or without a
GitHub/Slack account of their own — get the same capabilities through this path. If you
run both tiers, keep both: the gateway plugin handles channel traffic, the cowork MCP
handles session-driven asks.

### The generic HTTP bridge + token auto-refresh

Registered HTTP manifests in `mcp/` are served by **one** generic, dependency-free stdio MCP
server: `servers/bench-http-bridge.js <manifest.json>`. It registers the manifest's
tools, re-reads `~/.claude/config/bench-cowork.json` on every call (so a fresh
`/bench-login` is picked up without a restart), and on a `401 COWORK_BAD_TOKEN` it
auto-refreshes the cowork JWT via `POST /cowork/auth/refresh`, persists the new token
atomically (tmp file + rename, `chmod 600`), and retries the call once — no more
weekly bridge death when the 7-day token expires. Refresh exhaustion
(`COWORK_REFRESH_EXPIRED` / `COWORK_REFRESH_CHAIN_TOO_OLD`) means re-running
`/bench-login`.

## What this doesn't do

- **Local daemons** (gateway, fs.watch, wiki-mirror, dreaming crons) — OpenClaw only
- **Personal vault on disk** — API-mediated; install OpenClaw for local mirror
- **Offline mode** — requires benchagi.com reachable

These are deliberate choices to keep Cowork install light. Upgrade to Tier B when you need them.

## Development

This plugin ships from the BenchAGI monorepo at `tools/bench-cowork/`. Versioned with the rest of the monorepo. Dependabot bumps keep plugin schemas in sync with backend API changes.

Layout:
```
tools/bench-cowork/
  plugin.json            # Claude Code plugin manifest
  skills/                # Claude Code skills (frontmatter format)
  agents/                # Subagent .md files (name, description, system prompt)
  commands/              # Slash command .md files
  mcp/                   # MCP server manifests (HTTP clients)
  servers/               # Generic stdio bridge that serves the HTTP manifests
  hooks/                 # Pre/post hook scripts
```

## Status

**Shipped 2026-04-20 (Cycle 6)** — 7 agents + 10 skills + 7 registered MCP servers + `/bench-login` auth flow + Amendment-10 pre-commit hook. Rate-limiter is stubbed pending Cycle 7 wire-up.

| Surface | Count | Status |
|---|---|---|
| Agents | 7 | ✅ Aurelius, Ember, Bailey, Cole, Piper, Kestrel-Coder, Sage |
| Skills | 10 | ✅ aurelius-email, triage-mail, wiki-capture, hammer-anvil, simplify, customize-experience, bench-onboarding, review, security-review, forge-report |
| Slash commands | 10 | ✅ `/aurelius`, `/ember`, `/bailey`, `/cole`, `/piper`, `/sage`, `/kestrel-coder`, `/wiki-capture`, `/bench-login`, `/forge-report` |
| MCP servers | 7 | ✅ bench-wiki, bench-canvas, bench-slack, bench-mail, bench-chassis, bench-deals, bench-forge |
| Hooks | 1 | ✅ pre-commit canvas-update nudge (Amendment 10) |
| Cloud endpoints | 9 | ✅ `/api/v1/cowork/{auth,auth/refresh,canvas/tile,canvas/drift,canvas/edges,slack/sessions,slack/sessions/send,slack/history,forge/ticket}` |

### Known limits (deferred to Cycle 7)

- **Rate-limiter is a pass-through** — `apps/web/src/lib/cowork/rate-limit-stub.ts` has TODO markers.
- **Slack relay wire-up is stubbed** — routes return `status: "queued"` pending in-process wiring to `tools/slack-relay/`.
- **Slack history read is stubbed** — returns empty `messages[]`.
- **Path B OAuth device-code** is deferred — only pilot customers who block on it should trigger it.
