# Bench Cowork — agents + skills for Claude Code

**Tier D** of the BenchAGI harness ladder. Install in 60 seconds. No OpenClaw required.

## What this gives you

- **7 agent personalities** as Claude Code subagents: Aurelius, Ember, Bailey, Cole, Piper, Kestrel-Coder, Sage
- **Skills**: `aurelius-email`, `wiki-capture`, `hammer-anvil`, `simplify`, `review`, `security-review`, `bench-onboarding`
- **Slash commands**: `/aurelius`, `/ember`, `/bailey`, `/cole`, `/piper`, `/sage`, `/wiki-capture`, `/bench-login`
- **MCP servers**: `bench-wiki` (canon read/write), `bench-canvas` (tile updates + drift), `bench-slack` (optional)
- **Hook**: Amendment 10 enforcement — PRs touching canvas-tracked code paths must update the tile

All powered by benchagi.com over HTTPS. No local daemons, no fs.watch, no launchd.

## Install (60 seconds)

```bash
# In any Claude Code session
/plugin add https://github.com/BenchAGI/bench-cowork

# Authenticate (opens browser)
/bench-login your-email@domain.com
```

That's it. Try:

```bash
/aurelius can you follow up with the JC pilot team?
@bailey help me triage my inbox
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
  hooks/                 # Pre/post hook scripts
```

## Status

**Shipped 2026-04-20 (Cycle 6)** — 7 agents + 7 skills + 3 MCP servers + `/bench-login` auth flow + Amendment-10 pre-commit hook. Rate-limiter is stubbed pending Cycle 7 wire-up.

| Surface | Count | Status |
|---|---|---|
| Agents | 7 | ✅ Aurelius, Ember, Bailey, Cole, Piper, Kestrel-Coder, Sage |
| Skills | 7 | ✅ aurelius-email, wiki-capture, hammer-anvil, simplify, bench-onboarding, review, security-review |
| Slash commands | 9 | ✅ `/aurelius`, `/ember`, `/bailey`, `/cole`, `/piper`, `/sage`, `/kestrel-coder`, `/wiki-capture`, `/bench-login` |
| MCP servers | 3 | ✅ bench-wiki, bench-canvas, bench-slack (bench-excalidraw draft) |
| Hooks | 1 | ✅ pre-commit canvas-update nudge (Amendment 10) |
| Cloud endpoints | 7 | ✅ `/api/v1/cowork/{auth,canvas/tile,canvas/drift,canvas/edges,slack/sessions,slack/sessions/send,slack/history}` |

### Known limits (deferred to Cycle 7)

- **Rate-limiter is a pass-through** — `apps/web/src/lib/cowork/rate-limit-stub.ts` has TODO markers.
- **Slack relay wire-up is stubbed** — routes return `status: "queued"` pending in-process wiring to `tools/slack-relay/`.
- **Slack history read is stubbed** — returns empty `messages[]`.
- **Path B OAuth device-code** is deferred — only pilot customers who block on it should trigger it.
