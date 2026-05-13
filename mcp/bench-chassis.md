# Bench Chassis MCP

`bench-chassis` exposes the existing BenchAGI Chassis read surface to local agent clients. It lets an agent inspect the live Chassis capability registry, OpenAPI document, instance config, deployment health, manifest, and resolved harness bundle without adding any new `/api/v1/chassis/*` routes.

## Authentication

Chassis routes use `X-API-Key`, not cowork bearer auth. Set:

```bash
export BENCH_CHASSIS_API_KEY='bench_<instanceId>_<secret>'
export BENCH_API_BASE='https://benchagi.com/api/v1'
```

`BENCH_API_BASE` is optional and defaults to `https://benchagi.com/api/v1`. `BENCH_CHASSIS_API_KEY` is required.

Generate or copy a Chassis API key from Bench admin at `/admin/chassis/settings`. Cory still needs to provision the key for Jim Johnson's WisdomIS instance `SYZPonQO9yYpcttEv0Nj`; that provisioning is separate from this PR.

The OpenAPI document at `/chassis/openapi` is public and works with or without an API key. Other `bench-chassis` tools require `BENCH_CHASSIS_API_KEY`.

If the key is missing, the bridge reports:

```text
BENCH_CHASSIS_API_KEY is required for bench-chassis MCP calls. Set it to a Chassis API key in bench_<instanceId>_<secret> format.
```

If a cowork bearer token is used by mistake, the bridge reports:

```text
Looks like you passed a Bearer token. The Chassis MCP needs BENCH_CHASSIS_API_KEY (format bench_<instanceId>_<secret>). Cowork tokens are for /api/v1/cowork/*, not /chassis/*.
```

## Example

```bash
BENCH_CHASSIS_API_KEY='bench_<instanceId>_<secret>' \
BENCH_API_BASE='https://benchagi.com/api/v1' \
claude mcp add bench-chassis
```

## Jim Install Verification

After pulling latest on the Mac Studio:

```bash
cd <his bench install path>
claude mcp add bench-chassis
# expected output: 'bench-chassis' registered.
claude mcp list | grep bench-chassis
```

## Production Smoke

Obtain a test Chassis API key from Bench admin at `/admin/chassis/settings`, then run:

```bash
BENCH_E2E_API_KEY=bench_... pnpm test tools/bench-cowork/__tests__/bench-chassis-smoke.test.ts -t "e2e"
```

The e2e smoke is skipped when `BENCH_E2E_API_KEY` is unset so normal CI stays offline.
