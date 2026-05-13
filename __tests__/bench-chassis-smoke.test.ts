import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const descriptorPath = resolve(__dirname, '../mcp/bench-chassis.json');
const pluginPath = resolve(__dirname, '../plugin.json');

type Descriptor = {
  name: string;
  transport: {
    base: string;
    default_base: string;
    auth: {
      header: string;
      token_env: string;
      missing_message: string;
      invalid_bearer_message: string;
    };
    headers: Record<string, string>;
  };
  tools: Array<{
    name: string;
    method: string;
    path: string;
    auth_required?: boolean;
    query_params?: string[];
    inputSchema: {
      type: string;
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
  }>;
};

function loadDescriptor(): Descriptor {
  return JSON.parse(readFileSync(descriptorPath, 'utf8')) as Descriptor;
}

function resolveTemplate(value: string, env: Record<string, string | undefined>, fallback?: string) {
  const match = value.match(/^\$\{([^}]+)\}$/);
  if (!match) return value;
  return env[match[1]] ?? fallback ?? '';
}

async function callTool(
  descriptor: Descriptor,
  toolName: string,
  input: Record<string, string | boolean | undefined>,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
) {
  const tool = descriptor.tools.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`Unknown bench-chassis tool: ${toolName}`);

  const requiresAuth = tool.auth_required !== false;
  const apiKey = env[descriptor.transport.auth.token_env];
  if (requiresAuth && !apiKey) {
    throw new Error(descriptor.transport.auth.missing_message);
  }
  if (requiresAuth && apiKey?.startsWith('Bearer ')) {
    throw new Error(descriptor.transport.auth.invalid_bearer_message);
  }

  const base = resolveTemplate(descriptor.transport.base, env, descriptor.transport.default_base);
  const url = new URL(`${base.replace(/\/$/, '')}${tool.path}`);
  for (const param of tool.query_params ?? []) {
    const value = input[param];
    if (value !== undefined) url.searchParams.set(param, String(value));
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (requiresAuth) {
    headers['X-API-Key'] = apiKey!;
  }

  return fetchImpl(url, {
    method: tool.method,
    headers,
  });
}

function extractInstanceId(apiKey: string): string {
  const match = apiKey.match(/^bench_([^_]+)_.+$/);
  if (!match) throw new Error('BENCH_E2E_API_KEY must use bench_<instanceId>_<secret> format.');
  return match[1];
}

describe('bench-chassis MCP descriptor', () => {
  it('parses and exposes the expected read-only Chassis tools', () => {
    const descriptor = loadDescriptor();
    const plugin = JSON.parse(readFileSync(pluginPath, 'utf8')) as {
      claudeCode: { provides: { mcp: string[] } };
    };

    expect(descriptor.name).toBe('bench-chassis');
    expect(plugin.claudeCode.provides.mcp).toContain('mcp/bench-chassis.json');
    expect(descriptor.transport.default_base).toBe('https://benchagi.com/api/v1');
    expect(descriptor.transport.auth.header).toBe('X-API-Key');
    expect(descriptor.transport.auth.token_env).toBe('BENCH_CHASSIS_API_KEY');
    expect(descriptor.transport.headers).toEqual({
      'X-API-Key': '${BENCH_CHASSIS_API_KEY}',
      'Content-Type': 'application/json',
    });

    expect(descriptor.tools.map((tool) => [tool.name, tool.method, tool.path])).toEqual([
      ['chassis_capabilities', 'GET', '/chassis/capabilities'],
      ['chassis_openapi', 'GET', '/chassis/openapi'],
      ['chassis_config_get', 'GET', '/chassis/config'],
      ['chassis_health', 'GET', '/chassis/health'],
      ['chassis_manifest_get', 'GET', '/chassis/manifest'],
      ['chassis_harness_pull', 'GET', '/chassis/harness/pull'],
    ]);

    for (const tool of descriptor.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }

    expect(descriptor.tools.find((tool) => tool.name === 'chassis_openapi')).toMatchObject({
      auth_required: false,
    });
  });

  it('resolves paths, query params, and Chassis API-key headers without real network', async () => {
    const descriptor = loadDescriptor();
    const fetchMock = vi.fn(async (_url: URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ ok: true }));
    });

    await callTool(
      descriptor,
      'chassis_health',
      { chassisId: 'mac-studio', detailed: true },
      {
        BENCH_CHASSIS_API_KEY: 'bench_SYZPonQO9yYpcttEv0Nj_secret',
        BENCH_API_BASE: 'https://benchagi.com/api/v1',
      },
      fetchMock as unknown as typeof fetch,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      'https://benchagi.com/api/v1/chassis/health?chassisId=mac-studio&detailed=true',
    );
    expect(init).toMatchObject({
      method: 'GET',
      headers: {
        'X-API-Key': 'bench_SYZPonQO9yYpcttEv0Nj_secret',
        'Content-Type': 'application/json',
      },
    });
  });

  it('uses the production API base default when BENCH_API_BASE is unset', async () => {
    const descriptor = loadDescriptor();
    const fetchMock = vi.fn(async (_url: URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ ok: true }));
    });

    await callTool(
      descriptor,
      'chassis_harness_pull',
      { channel: 'stable-roofing' },
      { BENCH_CHASSIS_API_KEY: 'bench_SYZPonQO9yYpcttEv0Nj_secret' },
      fetchMock as unknown as typeof fetch,
    );

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      'https://benchagi.com/api/v1/chassis/harness/pull?channel=stable-roofing',
    );
  });

  it('errors clearly before fetch when BENCH_CHASSIS_API_KEY is unset', async () => {
    const descriptor = loadDescriptor();
    const fetchMock = vi.fn(async (_url: URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ ok: true }));
    });

    await expect(
      callTool(
        descriptor,
        'chassis_capabilities',
        {},
        { BENCH_API_BASE: 'https://example.test/api/v1' },
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toThrow(
      'BENCH_CHASSIS_API_KEY is required for bench-chassis MCP calls. Set it to a Chassis API key in bench_<instanceId>_<secret> format.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('errors clearly before fetch when BENCH_CHASSIS_API_KEY is a bearer token', async () => {
    const descriptor = loadDescriptor();
    const fetchMock = vi.fn(async (_url: URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ ok: true }));
    });

    await expect(
      callTool(
        descriptor,
        'chassis_capabilities',
        {},
        { BENCH_CHASSIS_API_KEY: 'Bearer cowork-token' },
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toThrow(
      'Looks like you passed a Bearer token. The Chassis MCP needs BENCH_CHASSIS_API_KEY (format bench_<instanceId>_<secret>). Cowork tokens are for /api/v1/cowork/*, not /chassis/*.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not attach X-API-Key for the public chassis_openapi tool', async () => {
    const descriptor = loadDescriptor();
    const fetchMock = vi.fn(async (_url: URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ ok: true }));
    });

    await callTool(
      descriptor,
      'chassis_openapi',
      {},
      {},
      fetchMock as unknown as typeof fetch,
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://benchagi.com/api/v1/chassis/openapi');
    expect(init).toMatchObject({
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    expect((init?.headers as Record<string, string>)['X-API-Key']).toBeUndefined();
  });
});

describe('bench-chassis MCP production e2e', () => {
  const e2e = process.env.BENCH_E2E_API_KEY ? it : it.skip;

  e2e('e2e: validates production Chassis capabilities, OpenAPI, and health', async () => {
    const apiKey = process.env.BENCH_E2E_API_KEY!;
    const instanceId = extractInstanceId(apiKey);
    const base = 'https://benchagi.com/api/v1';

    const capabilities = await fetch(`${base}/chassis/capabilities`, {
      headers: { 'X-API-Key': apiKey },
    });
    expect(capabilities.status).toBe(200);
    const capabilitiesBody = await capabilities.json();
    expect(capabilitiesBody.permissions?.instanceId).toBe(instanceId);

    const openapi = await fetch(`${base}/chassis/openapi`);
    expect(openapi.status).toBe(200);

    const health = await fetch(`${base}/chassis/health`, {
      headers: { 'X-API-Key': apiKey },
    });
    expect(health.status).toBe(200);
  });
});
