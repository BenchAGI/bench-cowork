---
name: customize-experience
description: Use when a Bench user asks how to customize, personalize, configure, re-theme, or adjust the app, workspace, pipeline, agents, dock pins, customer portal, workflows, or experience profile.
---

# Customize Experience

Use `/app/wiki/customize-your-experience` as the official user-facing guide.

## Workflow

1. Link the guide first when the user needs a visual path:

   `https://benchagi.com/app/wiki/customize-your-experience`

2. Check canon when available:

   - `wiki_search` query: `customize experience`
   - Canon page: `canon/topics/customize-your-experience-guide.md`

3. Gate the answer by the user's access:

   | Rarity | Rank | Guidance |
   |---|---|---|
   | Common | `white` | Personal controls and visible day-to-day surfaces |
   | Uncommon | `green` | Team-aware workflow guidance when visible |
   | Rare | `blue` | Manager-level operating views |
   | Epic | `purple` | Admin setup, roles, billing, integrations, AI controls |
   | Legendary | `orange` | Super-admin canon, chassis, platform controls |

4. Distinguish guidance from mutation:

   - If you only have the Bench Cowork plugin, guide the user and capture durable gaps with `wiki-capture`.
   - If you also have app/API credentials, read current state before suggesting changes.
   - Do not invent write access. Make changes only through documented endpoints and only after the user asks for the exact change.

## Known App/API Paths

- Guide: `/app/wiki/customize-your-experience`
- Discover visible customization surfaces: `GET /api/v1/wiki/nav?q=customize&limit=100`
- Read tenant config: `GET /api/v1/chassis/config`
- Admin config mutation: `PATCH /api/v1/chassis/config`
- Read experience profile: `GET /api/v1/chassis/experience`
- Experience mutation: `PUT /api/v1/chassis/experience` with `experience:write`
- Dock pins: `GET/PUT /api/v1/preferences/dock` with a bearer user session only, not an API key

## Boundaries

- Never present hidden admin or super-admin links as available to a lower-rank user.
- Never mutate billing, roles, integrations, customer-facing collateral, or agent behavior without a specific request and proper permission.
- If no safe write path applies, send the guide link and route to Aurelius or an admin.
