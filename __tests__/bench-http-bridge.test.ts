import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bridgePath = resolve(__dirname, '../servers/bench-http-bridge.js');
const forgeManifestPath = resolve(__dirname, '../mcp/bench-forge.json');
const dealsManifestPath = resolve(__dirname, '../mcp/bench-deals.json');

const children: ChildProcessWithoutNullStreams[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'bench-http-bridge-'));
  tempDirs.push(dir);
  return dir;
}

// `configPath: undefined` starts the bridge with no BENCH_COWORK_CONFIG at all
// (spawn drops undefined variables), as a session the launcher did not start.
function spawnBridge(
  configPath: string | undefined,
  manifestPath: string = forgeManifestPath,
  env: Record<string, string | undefined> = {},
) {
  const child = spawn(process.execPath, [bridgePath, manifestPath], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ...env,
      BENCH_COWORK_CONFIG: configPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  children.push(child);

  const messages: Array<Record<string, unknown>> = [];
  let stdout = '';
  let stderr = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    let newline = stdout.indexOf('\n');
    while (newline !== -1) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line.length > 0) messages.push(JSON.parse(line));
      newline = stdout.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  function send(message: Record<string, unknown>) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async function waitForMessageCount(count: number): Promise<Array<Record<string, unknown>>> {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (messages.length >= count) return messages;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    throw new Error(`timed out waiting for ${count} bridge messages; stderr=${stderr}`);
  }

  return { child, send, waitForMessageCount };
}

function writeConfig(path: string, config: Record<string, unknown>) {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function readPrivateConfig(configPath: string): Record<string, unknown> {
  const descriptor = openSync(
    configPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const entry = fstatSync(descriptor);
    expect(entry.isFile()).toBe(true);
    expect(entry.nlink).toBe(1);
    expect(entry.mode & 0o777).toBe(0o600);
    return JSON.parse(readFileSync(descriptor, 'utf8')) as Record<string, unknown>;
  } finally {
    closeSync(descriptor);
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += String(chunk);
  return body;
}

function json(res: ServerResponse, status: number, body: Record<string, unknown>) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

describe('bench-http-bridge', () => {
  it('lists bench-forge tools with required body fields', async () => {
    const dir = makeTempDir();
    const configPath = resolve(dir, 'bench-cowork.json');
    writeConfig(configPath, { bench_cowork_token: 'fresh-token' });
    const bridge = spawnBridge(configPath);

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

    const messages = await bridge.waitForMessageCount(2);
    const list = messages.find((message) => message.id === 2)?.result as {
      tools: Array<{ name: string; inputSchema: { required?: string[] } }>;
    };

    expect(list.tools.map((tool) => tool.name)).toEqual([
      'forge_submit_diagnostics',
      'forge_ticket_status',
    ]);
    expect(
      list.tools.find((tool) => tool.name === 'forge_submit_diagnostics')?.inputSchema.required,
    ).toEqual(['severity', 'subject', 'body']);
  });

  it.each([
    'http://benchagi.com/api/v1',
    'https://benchagi.com.attacker.example/api/v1',
    'https://benchagi.com@attacker.example/api/v1',
    'https://benchagi.com/api/v1/wiki',
    'https://benchagi.com/api/v1?redirect=attacker.example',
    'https://benchagi.com/api/v1#fragment',
  ])('refuses unsafe cowork base %s before sending the bearer token', async (base) => {
    const dir = makeTempDir();
    const configPath = resolve(dir, 'bench-cowork.json');
    writeConfig(configPath, {
      bench_api_base: base,
      bench_cowork_token: 'test-token',
    });

    const bridge = spawnBridge(configPath);
    bridge.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'forge_ticket_status',
        arguments: { ticketId: 'fgt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      },
    });

    const [message] = await bridge.waitForMessageCount(1);
    const result = message?.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Bench API base must/);
  });

  it('keeps the loopback seam unavailable outside test mode', async () => {
    const dir = makeTempDir();
    const configPath = resolve(dir, 'bench-cowork.json');
    writeConfig(configPath, {
      bench_api_base: 'http://127.0.0.1:65535/api/v1',
      bench_cowork_token: 'test-token',
    });

    const bridge = spawnBridge(configPath, forgeManifestPath, { NODE_ENV: 'production' });
    bridge.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'forge_ticket_status',
        arguments: { ticketId: 'fgt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      },
    });

    const [message] = await bridge.waitForMessageCount(1);
    const result = message?.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Bench API base must/);
  });

  it.each([
    { label: 'configured tenant pin', configuredInstanceId: 'D3nfrvqTaPqc3rJRkj6Q', expectedHeader: 'D3nfrvqTaPqc3rJRkj6Q' },
    { label: 'absent tenant pin', configuredInstanceId: undefined, expectedHeader: undefined },
  ])('keeps bearer calls scoped for $label', async ({ configuredInstanceId, expectedHeader }) => {
    const dir = makeTempDir();
    const configPath = resolve(dir, 'bench-cowork.json');
    let observedInstanceHeader: string | undefined;
    const server = createServer((req, res) => {
      observedInstanceHeader = req.headers['x-instance-id'] as string | undefined;
      expect(req.headers.authorization).toBe('Bearer fresh-token');
      json(res, 200, { ticketId: 'fgt_cccccccccccccccccccccccccccccccc', status: 'queued' });
    });

    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('server did not bind to a port');
      writeConfig(configPath, {
        bench_api_base: `http://127.0.0.1:${address.port}/api/v1`,
        bench_cowork_token: 'fresh-token',
        ...(configuredInstanceId ? { bench_instance_id: configuredInstanceId } : {}),
      });

      const bridge = spawnBridge(configPath);
      bridge.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'forge_ticket_status',
          arguments: { ticketId: 'fgt_cccccccccccccccccccccccccccccccc' },
        },
      });

      const [message] = await bridge.waitForMessageCount(1);
      const result = message.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).not.toBe(true);
      expect(observedInstanceHeader).toBe(expectedHeader);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it.each([
    '../another-tenant',
    '',
    '   ',
    'tenant\nforged-header',
    'tenant.with.dots',
    'x'.repeat(129),
    42,
  ])('rejects invalid configured tenant pin %j before making a request', async (invalidInstanceId) => {
    const dir = makeTempDir();
    const configPath = resolve(dir, 'bench-cowork.json');
    let requestCount = 0;
    const server = createServer((_req, res) => {
      requestCount += 1;
      json(res, 500, { error: 'request should not have been sent' });
    });

    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('server did not bind to a port');
      writeConfig(configPath, {
        bench_api_base: `http://127.0.0.1:${address.port}/api/v1`,
        bench_cowork_token: 'fresh-token',
        bench_instance_id: invalidInstanceId,
      });

      const bridge = spawnBridge(configPath);
      bridge.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'forge_ticket_status',
          arguments: { ticketId: 'fgt_dddddddddddddddddddddddddddddddd' },
        },
      });

      const [message] = await bridge.waitForMessageCount(1);
      const result = message.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/bench_instance_id must/);
      expect(requestCount).toBe(0);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('substitutes path params and forwards JSON bodies for API-key manifests', async () => {
    const dir = makeTempDir();
    const configPath = resolve(dir, 'bench-cowork.json');

    const requests: Array<{ method: string; pathname: string; body: unknown }> = [];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const bodyText = await readBody(req);
      const body = bodyText ? JSON.parse(bodyText) : null;
      requests.push({ method: req.method ?? '', pathname: url.pathname, body });

      expect(req.headers['x-api-key']).toBe('bench_test_secret');
      expect(req.headers['x-instance-id']).toBeUndefined();

      if (req.method === 'GET' && url.pathname === '/api/v1/chassis/deals/deal%201%2F2') {
        json(res, 200, { id: 'deal 1/2', ok: true });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/chassis/deals') {
        json(res, 201, { id: 'new-deal', received: body });
        return;
      }

      json(res, 404, { error: 'not found' });
    });

    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('server did not bind to a port');
      writeConfig(configPath, {
        bench_api_base: `http://127.0.0.1:${address.port}/api/v1`,
        bench_instance_id: 'tenant-must-not-forward-on-api-key',
      });

      const bridge = spawnBridge(configPath, dealsManifestPath, {
        BENCH_CHASSIS_API_KEY: 'bench_test_secret',
      });
      bridge.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'deal_get',
          arguments: { id: 'deal 1/2' },
        },
      });
      bridge.send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'deal_create',
          arguments: {
            customerName: 'Briggs Roofing',
            title: 'Briggs reroof',
            estimatedValue: 42000,
          },
        },
      });

      const messages = await bridge.waitForMessageCount(2);
      const getResult = messages.find((message) => message.id === 1)?.result as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      const createResult = messages.find((message) => message.id === 2)?.result as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };

      expect(getResult.isError).not.toBe(true);
      expect(createResult.isError).not.toBe(true);
      expect(JSON.parse(getResult.content[0].text)).toEqual({ id: 'deal 1/2', ok: true });
      expect(JSON.parse(createResult.content[0].text)).toMatchObject({
        id: 'new-deal',
        received: {
          customerName: 'Briggs Roofing',
          title: 'Briggs reroof',
          estimatedValue: 42000,
        },
      });
      expect(requests).toEqual([
        { method: 'GET', pathname: '/api/v1/chassis/deals/deal%201%2F2', body: null },
        {
          method: 'POST',
          pathname: '/api/v1/chassis/deals',
          body: {
            customerName: 'Briggs Roofing',
            title: 'Briggs reroof',
            estimatedValue: 42000,
          },
        },
      ]);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('refreshes one stale cowork token for concurrent calls, persists it, and retries', async () => {
    const dir = makeTempDir();
    const configPath = resolve(dir, 'bench-cowork.json');
    writeConfig(configPath, {
      bench_api_base: 'http://127.0.0.1:0/api/v1',
      bench_cowork_token: 'stale-token',
    });

    let refreshCount = 0;
    const submitAuthHeaders: string[] = [];
    const submitInstanceHeaders: Array<string | undefined> = [];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/api/v1/cowork/auth/refresh') {
        await readBody(req);
        refreshCount += 1;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        expect(req.headers.authorization).toBe('Bearer stale-token');
        expect(req.headers['x-instance-id']).toBeUndefined();
        json(res, 200, { token: 'fresh-token', expiresInSeconds: 3600 });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/cowork/forge/ticket') {
        const body = JSON.parse(await readBody(req));
        expect(body).toMatchObject({
          severity: 'sev-2',
          subject: 'Bridge retry smoke',
          body: 'diagnostic body',
        });
        const auth = req.headers.authorization ?? '';
        submitAuthHeaders.push(auth);
        submitInstanceHeaders.push(req.headers['x-instance-id'] as string | undefined);
        if (auth === 'Bearer stale-token') {
          json(res, 401, { code: 'COWORK_BAD_TOKEN' });
          return;
        }
        if (auth === 'Bearer fresh-token') {
          json(res, 201, {
            ticketId: 'fgt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            status: 'queued',
          });
          return;
        }
      }

      json(res, 404, { error: 'not found' });
    });

    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('server did not bind to a port');
      writeConfig(configPath, {
        bench_api_base: `http://127.0.0.1:${address.port}/api/v1`,
        bench_cowork_token: 'stale-token',
        bench_instance_id: 'D3nfrvqTaPqc3rJRkj6Q',
      });
      chmodSync(dir, 0o755);
      chmodSync(configPath, 0o644);

      const bridge = spawnBridge(configPath);
      const callParams = {
        name: 'forge_submit_diagnostics',
        arguments: {
          severity: 'sev-2',
          subject: 'Bridge retry smoke',
          body: 'diagnostic body',
        },
      };
      bridge.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: callParams });
      bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: callParams });

      const messages = await bridge.waitForMessageCount(2);
      for (const id of [1, 2]) {
        const result = messages.find((message) => message.id === id)?.result as {
          content: Array<{ text: string }>;
          isError?: boolean;
        };
        expect(result.isError).not.toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          ticketId: 'fgt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          status: 'queued',
        });
      }

      expect(refreshCount).toBe(1);
      expect(submitAuthHeaders.filter((header) => header === 'Bearer stale-token')).toHaveLength(2);
      expect(submitAuthHeaders.filter((header) => header === 'Bearer fresh-token')).toHaveLength(2);
      expect(submitInstanceHeaders).toEqual([
        'D3nfrvqTaPqc3rJRkj6Q',
        'D3nfrvqTaPqc3rJRkj6Q',
        'D3nfrvqTaPqc3rJRkj6Q',
        'D3nfrvqTaPqc3rJRkj6Q',
      ]);
      expect(readPrivateConfig(configPath).bench_cowork_token).toBe('fresh-token');
      expect(statSync(dirname(configPath)).mode & 0o777).toBe(0o700);
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('replaces a config symlink that appears while a stale token is refreshed', async () => {
    const dir = makeTempDir();
    const configPath = resolve(dir, 'bench-cowork.json');
    const protectedPath = resolve(dir, 'protected.json');
    writeConfig(configPath, { bench_cowork_token: 'stale-token' });
    writeConfig(protectedPath, { bench_cowork_token: 'protected-token' });

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/api/v1/cowork/forge/ticket') {
        if (req.headers.authorization === 'Bearer stale-token') {
          rmSync(configPath);
          symlinkSync(protectedPath, configPath);
          json(res, 401, { code: 'COWORK_BAD_TOKEN' });
          return;
        }
        if (req.headers.authorization === 'Bearer fresh-token') {
          json(res, 201, {
            ticketId: 'fgt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            status: 'queued',
          });
          return;
        }
        json(res, 401, { code: 'COWORK_BAD_TOKEN' });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/cowork/auth/refresh') {
        expect(req.headers.authorization).toBe('Bearer stale-token');
        json(res, 200, { token: 'fresh-token', expiresInSeconds: 3600 });
        return;
      }
      json(res, 404, { error: 'not found' });
    });

    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('server did not bind to a port');
      writeConfig(configPath, {
        bench_api_base: `http://127.0.0.1:${address.port}/api/v1`,
        bench_cowork_token: 'stale-token',
      });

      const bridge = spawnBridge(configPath);
      bridge.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'forge_submit_diagnostics',
          arguments: { severity: 'sev-2', subject: 'symlink test', body: 'test body' },
        },
      });

      const [message] = await bridge.waitForMessageCount(1);
      const result = message.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        ticketId: 'fgt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        status: 'queued',
      });
      expect(readPrivateConfig(configPath).bench_cowork_token).toBe('fresh-token');
      expect(JSON.parse(readFileSync(protectedPath, 'utf8')).bench_cowork_token).toBe('protected-token');
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});


describe('credentialed bridge response limits', () => {
  it.each(['normal', 'redirect', 'declared', 'streamed', 'private-error', 'transport-error'])('guards %s responses at the real stdio boundary', async (mode) => {
    const dir = makeTempDir();
    const configPath = resolve(dir, 'bench-cowork.json');
    const preload = resolve(dir, 'fetch.cjs');
    const callsPath = resolve(dir, 'calls.json');
    writeConfig(configPath, { bench_api_base: 'https://benchagi.com/api/v1', bench_cowork_token: 'fake-private-token' });
    writeFileSync(preload, `
      global.fetch = async (_url, init) => {
        require('node:fs').writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify({redirect: init.redirect}));
        const mode = ${JSON.stringify(mode)};
        if (mode === 'private-error') return new Response('fake-private-token', {status: 500});
        if (mode === 'transport-error') throw new Error('fake-private-token');
        if (mode === 'redirect') return new Response('fake-private-token', {status: 302});
        if (mode === 'declared') return new Response('small', {headers: {'content-length': String(8 * 1024 * 1024 + 1)}});
        if (mode === 'streamed') return new Response('x'.repeat(8 * 1024 * 1024 + 1));
        return new Response('{"status":"queued"}');
      };
    `);
    const bridge = spawnBridge(configPath, forgeManifestPath, { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` });
    bridge.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'forge_ticket_status', arguments: { ticketId: 'fgt_cccccccccccccccccccccccccccccccc' },
    } });
    const [message] = await bridge.waitForMessageCount(1);
    const result = message.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(JSON.parse(readFileSync(callsPath, 'utf8')).redirect).toBe('error');
    if (mode === 'normal') {
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual({ status: 'queued' });
    } else {
      expect(result.isError).toBe(true);
      if (mode === 'redirect') expect(result.content[0].text).toMatch(/redirect/);
      if (mode === 'declared' || mode === 'streamed') expect(result.content[0].text).toMatch(/response too large/);
      expect(result.content[0].text).not.toContain('fake-private-token');
    }
  });
});

// #17232: the Aurelius seat kit gives every company on a Mac but one its own
// Claude root, ~/.aurelius/profiles/<profileId>/claude, and records each one it
// installs in ~/.aurelius/profile-registry. ~/.claude belongs to the one
// company that is not isolated, or to nobody.
describe('two companies on one Mac', () => {
  type Call = { authorization?: string; instanceId?: string };
  // profileId -> registry record, or raw text for a record that is not JSON.
  type Registry = Record<string, Record<string, unknown> | string>;

  function seatHome(registry: Registry) {
    const home = makeTempDir();
    for (const [profileId, record] of Object.entries(registry)) {
      const file = resolve(home, '.aurelius/profile-registry', `${profileId}.json`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, typeof record === 'string' ? record : JSON.stringify(record), { mode: 0o600 });
    }
    return home;
  }

  function companyConfig(home: string, profileId: string | null, token: string, instanceId: string, port: number) {
    const file = profileId === null
      ? resolve(home, '.claude/config/bench-cowork.json')
      : resolve(home, '.aurelius/profiles', profileId, 'claude/config/bench-cowork.json');
    mkdirSync(dirname(file), { recursive: true });
    writeConfig(file, {
      bench_api_base: `http://127.0.0.1:${port}/api/v1`,
      bench_cowork_token: token,
      bench_instance_id: instanceId,
    });
    return file;
  }

  async function withServer(run: (port: number, calls: Call[]) => Promise<void>) {
    const calls: Call[] = [];
    const server = createServer((req, res) => {
      calls.push({
        authorization: req.headers.authorization,
        instanceId: req.headers['x-instance-id'] as string | undefined,
      });
      json(res, 200, { ticketId: 'fgt_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', status: 'queued' });
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('server did not bind to a port');
      await run(address.port, calls);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }

  async function callForge(home: string, configPath: string | undefined) {
    const bridge = spawnBridge(configPath, forgeManifestPath, {
      HOME: home,
      BENCH_COWORK_TOKEN: undefined,
      BENCH_API_BASE: undefined,
      bench_api_base: undefined,
    });
    bridge.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'forge_ticket_status', arguments: { ticketId: 'fgt_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' } },
    });
    const [message] = await bridge.waitForMessageCount(1);
    return message.result as { content: Array<{ text: string }>; isError?: boolean };
  }

  const isolated = (profileId: string) => ({ profileId, isolation: 'profile' });

  it("has each company's bridge call Bench only as that company's own login", async () => {
    await withServer(async (port, calls) => {
      const home = seatHome({ 'company-alpha': isolated('company-alpha'), 'company-beta': isolated('company-beta') });
      companyConfig(home, null, 'primary-token', 'tenant-primary', port);
      const alpha = companyConfig(home, 'company-alpha', 'alpha-token', 'tenant-alpha-123', port);
      const beta = companyConfig(home, 'company-beta', 'beta-token', 'tenant-beta-123', port);

      expect((await callForge(home, alpha)).isError).not.toBe(true);
      expect((await callForge(home, beta)).isError).not.toBe(true);
      expect(calls).toEqual([
        { authorization: 'Bearer alpha-token', instanceId: 'tenant-alpha-123' },
        { authorization: 'Bearer beta-token', instanceId: 'tenant-beta-123' },
      ]);
    });
  });

  it("reports a company with no login as signed out instead of borrowing another company's", async () => {
    await withServer(async (port, calls) => {
      const home = seatHome({ 'company-alpha': isolated('company-alpha'), 'company-beta': isolated('company-beta') });
      companyConfig(home, null, 'primary-token', 'tenant-primary', port);
      companyConfig(home, 'company-alpha', 'alpha-token', 'tenant-alpha-123', port);
      const beta = resolve(home, '.aurelius/profiles/company-beta/claude/config/bench-cowork.json');

      const result = await callForge(home, beta);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toBe(
        `No cowork token found. Run /bench-login (writes ${beta}) or export BENCH_COWORK_TOKEN.`,
      );
      expect(calls).toEqual([]);
    });
  });

  it.each<{ label: string; registry: Registry }>([
    { label: 'a registered company has its own Claude root', registry: { 'company-alpha': isolated('company-alpha') } },
    { label: 'a registry record cannot be read', registry: { 'company-alpha': '{not json' } },
  ])('refuses the ~/.claude login when no config was named and $label', async ({ registry }) => {
    await withServer(async (port, calls) => {
      const home = seatHome(registry);
      companyConfig(home, null, 'primary-token', 'tenant-primary', port);

      const result = await callForge(home, undefined);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/^Signed out of Bench: BENCH_COWORK_CONFIG is not set/);
      expect(calls).toEqual([]);
    });
  });

  it.each(['link', 'fifo'] as const)('refuses, without hanging, when a registry record is a %s', async (kind) => {
    await withServer(async (port, calls) => {
      const home = seatHome({});
      companyConfig(home, null, 'primary-token', 'tenant-primary', port);
      const record = resolve(home, '.aurelius/profile-registry/company-alpha.json');
      mkdirSync(dirname(record), { recursive: true });
      if (kind === 'link') {
        const target = resolve(home, 'company-primary.json');
        writeFileSync(target, JSON.stringify({ profileId: 'company-primary' }));
        symlinkSync(target, record);
      } else {
        execFileSync('mkfifo', [record]);
      }

      const result = await callForge(home, undefined);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/^Signed out of Bench: BENCH_COWORK_CONFIG is not set/);
      expect(calls).toEqual([]);
    });
  });

  it.each<{ label: string; registry: Registry }>([
    { label: 'no company is registered', registry: {} },
    { label: 'the only registered company uses ~/.claude', registry: { 'company-primary': { profileId: 'company-primary' } } },
  ])('keeps the ~/.claude login when no config was named and $label', async ({ registry }) => {
    await withServer(async (port, calls) => {
      const home = seatHome(registry);
      companyConfig(home, null, 'primary-token', 'tenant-primary', port);

      expect((await callForge(home, undefined)).isError).not.toBe(true);
      expect(calls).toEqual([{ authorization: 'Bearer primary-token', instanceId: 'tenant-primary' }]);
    });
  });
});
