import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
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
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

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

function spawnBridge(
  configPath: string,
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
