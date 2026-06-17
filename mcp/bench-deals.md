# Bench Deals MCP

`bench-deals` exposes the existing BenchAGI deal + pipeline read/write surface to local agent clients, so an agent can list and create deals and read the pipeline summary without adding any new `/api/v1/chassis/*` routes. It mirrors the `bench-chassis` descriptor pattern; only the tool set differs.

Backing routes (already live in `apps/web/src/app/api/v1/chassis/`):
- `GET /chassis/deals` → `deals_list` (scope `deals:read`)
- `GET /chassis/deals/{id}` → `deal_get` (scope `deals:read`)
- `POST /chassis/deals` → `deal_create` (scope `deals:write`)
- `GET /chassis/pipeline` → `pipeline_summary` (scope `pipeline:read`, falls back to `deals:read`)

## Authentication

Chassis routes use `X-API-Key`, not cowork bearer auth. Set:

```bash
export BENCH_CHASSIS_API_KEY='bench_<instanceId>_<secret>'
export BENCH_API_BASE='https://benchagi.com/api/v1'
```

`BENCH_API_BASE` defaults to `https://benchagi.com/api/v1`. `BENCH_CHASSIS_API_KEY` is required and must carry the `deals:read` / `deals:write` / `pipeline:read` scopes for the instance. The tenant is vended by the key — the server ignores any client-supplied `instanceId`.

Generate or copy a Chassis API key from Bench admin at `/admin/chassis/settings`.

## Example — Claude Code (Tier D / bench-cowork)

```bash
BENCH_CHASSIS_API_KEY='bench_<instanceId>_<secret>' \
BENCH_API_BASE='https://benchagi.com/api/v1' \
claude mcp add bench-deals
```

## Example — local OpenClaw gateway (local-model customer)

OpenClaw loads HTTP MCP servers via `openclaw mcp add`. When the customer's gateway is configured with a served bridge URL, wire it on the customer's Mac with the per-instance Chassis key:

```bash
openclaw mcp add bench-deals \
  --transport streamable-http \
  --url "$BENCH_DEALS_MCP_URL" \
  --header "X-API-Key=bench_<instanceId>_<secret>"
openclaw mcp probe bench-deals    # confirm tools register
```

## Follow-ups

1. **OpenClaw load + serve URL.** Confirm the customer's local gateway wiring and set `BENCH_DEALS_MCP_URL` if it needs a `streamable-http`/`sse` endpoint instead of the Claude Code stdio bridge.
2. **Dual-vend mirror.** `bench-cowork` is mirrored from the monorepo (`tools/bench-cowork/`) to the standalone `BenchAGI/bench-cowork` repo by `.github/workflows/mirror-bench-cowork.yml` after this lands on `main`; verify the mirror run before customer install.
3. **Production smoke.** Add an e2e mirroring `__tests__/bench-chassis-smoke.test.ts` gated on `BENCH_E2E_API_KEY` once a disposable Chassis key with deal scopes is available.
