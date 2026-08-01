#!/usr/bin/env node
/**
 * bench-http-bridge — ONE generic stdio MCP server for every bench-cowork HTTP
 * manifest (bench-wiki, bench-canvas, bench-slack, bench-chassis, bench-forge;
 * draft manifests such as bench-excalidraw can also be run directly).
 *
 * Usage (one MCP server entry per manifest):
 *   node servers/bench-http-bridge.js mcp/bench-forge.json
 *
 * Design (per Jim Johnson's hand-written wiki bridge pattern):
 * - Zero dependencies. Node >= 18 (global fetch). Newline-delimited JSON-RPC 2.0
 *   over stdio per the MCP stdio transport.
 * - The manifest drives everything: each tools[] entry's method/path/query_params/
 *   body_schema becomes a registered MCP tool.
 * - Auth state is re-read from ~/.claude/config/bench-cowork.json ON EVERY CALL, so
 *   a fresh /bench-login (or another bridge process refreshing the token) is picked
 *   up without restarting the server.
 * - On a 401 with code COWORK_BAD_TOKEN: POST /cowork/auth/refresh with the stale
 *   token, persist the refreshed token atomically (tmp file + rename, chmod 600,
 *   update bench_cowork_expires_at), then retry the original call exactly once.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const BRIDGE_VERSION = '0.5.0';
const DEFAULT_API_BASE = 'https://benchagi.com/api/v1';
const ALLOWED_API_BASES = new Set([
  'https://benchagi.com/api/v1',
  'https://staging.benchagi.com/api/v1',
]);
const REFRESH_PATH = '/cowork/auth/refresh';
const HTTP_TIMEOUT_MS = Number(process.env.BENCH_BRIDGE_TIMEOUT_MS || 30000);

// --- manifest ----------------------------------------------------------------

const manifestPath = process.argv[2];
if (!manifestPath) {
  process.stderr.write('usage: bench-http-bridge.js <manifest.json>\n');
  process.exit(2);
}
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), 'utf8'));
} catch (err) {
  process.stderr.write(`bench-http-bridge: cannot read manifest ${manifestPath}: ${err.message}\n`);
  process.exit(2);
}
if (!manifest.transport || manifest.transport.type !== 'http' || !Array.isArray(manifest.tools)) {
  process.stderr.write('bench-http-bridge: manifest needs transport.type "http" and a tools[] array\n');
  process.exit(2);
}
const toolsByName = new Map(manifest.tools.map((tool) => [tool.name, tool]));

// --- config (re-read per call so logins/refreshes are picked up live) --------

function configPath() {
  const configuredPath = process.env.BENCH_COWORK_CONFIG
    || path.join(os.homedir(), '.claude', 'config', 'bench-cowork.json');
  if (!path.isAbsolute(configuredPath)) {
    throw new Error('BENCH_COWORK_CONFIG must be an absolute path');
  }

  const resolvedPath = path.resolve(configuredPath);
  const parentDirectory = path.dirname(resolvedPath);
  if (parentDirectory === path.parse(parentDirectory).root) {
    throw new Error('Cowork config must not be written directly to the filesystem root');
  }
  return resolvedPath;
}

function readConfig() {
  try {
    const file = configPath();
    const existing = fs.lstatSync(file);
    if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function resolveVar(name, config) {
  if (config[name] != null) return String(config[name]);
  const lower = name.toLowerCase();
  if (config[lower] != null) return String(config[lower]);
  if (process.env[name] != null) return process.env[name];
  if (process.env[name.toUpperCase()] != null) return process.env[name.toUpperCase()];
  return null;
}

function resolveBase(config) {
  const template = manifest.transport.base || '${bench_api_base}';
  const resolved = template.replace(/\$\{([^}]+)\}/g, (_, name) => resolveVar(name, config) || '');
  const base = resolved || manifest.transport.default_base || DEFAULT_API_BASE;
  return normalizeApiBase(base);
}

/**
 * Resolve the only API bases that may receive cowork bearer/API-key requests.
 *
 * The bridge rereads its token and base from local config for every call.
 * Keeping the base on the documented production/staging API origins prevents a
 * tampered config from redirecting those credentials. Integration tests may
 * use an ephemeral loopback server only with NODE_ENV=test.
 */
function normalizeApiBase(baseRaw) {
  const base = new URL(baseRaw);
  if (base.username || base.password) {
    throw new Error('Bench API base must not contain credentials');
  }
  if (base.search || base.hash) {
    throw new Error('Bench API base must not contain a query or fragment');
  }

  const pathName = base.pathname.replace(/\/+$/, '');
  const normalized = `${base.origin}${pathName}`;
  if (ALLOWED_API_BASES.has(normalized)) return normalized;

  const isTestLoopback = process.env.NODE_ENV === 'test'
    && base.protocol === 'http:'
    && (base.hostname === '127.0.0.1' || base.hostname === '::1' || base.hostname === 'localhost')
    && pathName === '/api/v1';
  if (isTestLoopback) return normalized;

  throw new Error('Bench API base must be a documented production or staging /api/v1 origin');
}

function resolveBearerToken(config) {
  // Config file first (refreshable on disk), env second (/bench-login suggests exporting it).
  const auth = manifest.transport.auth || {};
  return config.bench_cowork_token || (auth.token_env && process.env[auth.token_env]) || null;
}

function ensurePrivateConfigDirectory(file) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const entry = fs.lstatSync(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('Cowork config directory must be a non-symlink directory');
  }

  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(descriptor).isDirectory()) {
      throw new Error('Cowork config directory must be a directory');
    }
    fs.fchmodSync(descriptor, 0o700);
  } finally {
    fs.closeSync(descriptor);
  }
  return directory;
}

function assertSafeConfigOutput(file) {
  try {
    const existing = fs.lstatSync(file);
    if (existing.isSymbolicLink()) {
      throw new Error('Cowork config output must not be a symbolic link');
    }
    if (!existing.isFile() || existing.nlink !== 1) {
      throw new Error('Cowork config output must be an unlinked regular file');
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function persistToken(token, expiresInSeconds) {
  const file = configPath();
  const directory = ensurePrivateConfigDirectory(file);
  assertSafeConfigOutput(file);
  const config = readConfig();
  config.bench_cowork_token = token;
  if (Number.isFinite(expiresInSeconds)) {
    config.bench_cowork_expires_at = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  }
  // Atomic: private, exclusive temp file in the same directory followed by rename.
  const tmp = path.join(
    directory,
    `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  let descriptor = null;
  try {
    descriptor = fs.openSync(
      tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    const temporary = fs.fstatSync(descriptor);
    if (!temporary.isFile() || temporary.nlink !== 1) {
      throw new Error('Cowork config temporary output must be an unlinked regular file');
    }
    fs.writeFileSync(descriptor, JSON.stringify(config, null, 2) + '\n', 'utf8');
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(tmp, file);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(tmp, { force: true });
  }
}

// --- HTTP --------------------------------------------------------------------

function buildPath(tool, args) {
  let resolvedPath = tool.path;
  const pathKeys = Array.isArray(tool.path_params) ? tool.path_params : [];
  for (const key of pathKeys) {
    const value = args[key];
    if (value == null || value === '') {
      throw new Error(`Missing required path parameter "${key}"`);
    }
    resolvedPath = resolvedPath.replace(
      new RegExp(`\\{${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`, 'g'),
      encodeURIComponent(String(value))
    );
  }
  const unresolved = resolvedPath.match(/\{([^}]+)\}/);
  if (unresolved) {
    throw new Error(`Missing path parameter "${unresolved[1]}"`);
  }
  return resolvedPath;
}

async function httpCall(tool, args, headers, base) {
  const pathKeys = Array.isArray(tool.path_params) ? tool.path_params : [];
  const url = new URL(base + buildPath(tool, args));
  const queryKeys = Array.isArray(tool.query_params) ? tool.query_params : [];
  for (const key of queryKeys) {
    if (args[key] != null) url.searchParams.set(key, String(args[key]));
  }
  const method = (tool.method || 'GET').toUpperCase();
  const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) };
  if (method !== 'GET' && method !== 'HEAD') {
    const body = {};
    for (const [key, value] of Object.entries(args)) {
      if (!queryKeys.includes(key) && !pathKeys.includes(key)) body[key] = value;
    }
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body; keep raw text
  }
  return { status: res.status, json, text };
}

function errorCode(response) {
  const body = response.json;
  if (!body) return null;
  if (typeof body.code === 'string') return body.code;
  if (typeof body.error === 'string') return body.error;
  if (body.error && typeof body.error.code === 'string') return body.error.code;
  return null;
}

async function refreshToken(base, staleToken) {
  const response = await httpCall(
    { method: 'POST', path: REFRESH_PATH },
    {},
    { Authorization: `Bearer ${staleToken}` },
    base
  );
  if (response.status !== 200 || !response.json || !response.json.token) {
    const err = new Error(`refresh returned HTTP ${response.status}`);
    err.code = errorCode(response);
    throw err;
  }
  persistToken(response.json.token, Number(response.json.expiresInSeconds));
  return response.json.token;
}

// Single-flight: concurrent 401s share one refresh; cross-process refreshes are
// picked up from disk instead of minting a redundant token.
let refreshInFlight = null;

async function refreshTokenOnce(base, staleToken) {
  const onDisk = readConfig().bench_cowork_token;
  if (onDisk && onDisk !== staleToken) return onDisk;
  if (!refreshInFlight) {
    refreshInFlight = refreshToken(base, staleToken).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

// --- tool dispatch -------------------------------------------------------------

function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function toolResult(response) {
  const text = response.json != null ? JSON.stringify(response.json, null, 2) : response.text || '';
  if (response.status >= 200 && response.status < 300) {
    return { content: [{ type: 'text', text: text || `HTTP ${response.status}` }] };
  }
  return toolError(`HTTP ${response.status}: ${text}`);
}

async function callTool(tool, args) {
  const config = readConfig();
  const base = resolveBase(config);
  const auth = manifest.transport.auth || {};

  if (auth.type === 'api_key') {
    // API-key manifests (e.g. bench-chassis) are env-only — no refresh path.
    const key = auth.token_env ? process.env[auth.token_env] : null;
    if (!key && auth.required !== false && tool.auth_required !== false) {
      return toolError(auth.missing_message || `${auth.token_env} is required for ${manifest.name} calls.`);
    }
    return toolResult(await httpCall(tool, args, key ? { [auth.header || 'X-API-Key']: key } : {}, base));
  }

  let token = resolveBearerToken(config);
  if (!token) {
    return toolError(
      'No cowork token found. Run /bench-login (writes ~/.claude/config/bench-cowork.json) or export BENCH_COWORK_TOKEN.'
    );
  }
  let response = await httpCall(tool, args, { Authorization: `Bearer ${token}` }, base);
  if (response.status === 401 && errorCode(response) === 'COWORK_BAD_TOKEN') {
    // Stale token: sliding refresh with the stale token, persist, retry ONCE.
    try {
      token = await refreshTokenOnce(base, token);
    } catch (err) {
      const exhausted = err.code === 'COWORK_REFRESH_EXPIRED' || err.code === 'COWORK_REFRESH_CHAIN_TOO_OLD';
      return toolError(
        `401 COWORK_BAD_TOKEN and refresh failed (${err.code || err.message}). ` +
          (exhausted ? 'Refresh window exhausted — ' : '') +
          'Re-authenticate with /bench-login.'
      );
    }
    response = await httpCall(tool, args, { Authorization: `Bearer ${token}` }, base);
  }
  return toolResult(response);
}

// --- MCP tool registration -----------------------------------------------------

function inputSchemaFor(tool) {
  if (tool.inputSchema) return tool.inputSchema;
  const properties = {};
  const required = [];
  if (tool.body_schema) {
    for (const [key, value] of Object.entries(tool.body_schema)) {
      if (key.startsWith('_')) continue; // doc-only entries (e.g. bench-wiki's _entry_shape)
      properties[key] = { description: typeof value === 'string' ? value : JSON.stringify(value) };
      if (typeof value === 'string' && !/optional/i.test(value)) required.push(key);
    }
  }
  for (const key of tool.query_params || []) {
    if (!properties[key]) properties[key] = { type: 'string', description: `Query parameter "${key}".` };
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: true,
  };
}

// --- JSON-RPC over stdio (newline-delimited) -------------------------------------

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleRequest(request) {
  const { id, method, params } = request;
  switch (method) {
    case 'initialize':
      sendResult(id, {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: manifest.name, version: BRIDGE_VERSION },
      });
      return;
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return; // notifications get no response
    case 'ping':
      sendResult(id, {});
      return;
    case 'tools/list':
      sendResult(id, {
        tools: manifest.tools.map((tool) => ({
          name: tool.name,
          description: tool.description || '',
          inputSchema: inputSchemaFor(tool),
        })),
      });
      return;
    case 'tools/call': {
      const tool = toolsByName.get(params && params.name);
      if (!tool) {
        sendError(id, -32602, `Unknown tool: ${params && params.name}`);
        return;
      }
      try {
        sendResult(id, await callTool(tool, (params && params.arguments) || {}));
      } catch (err) {
        sendResult(id, toolError(`${tool.name} failed: ${err.message}`));
      }
      return;
    }
    default:
      if (id !== undefined && id !== null) sendError(id, -32601, `Method not found: ${method}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      sendError(null, -32700, 'Parse error');
      continue;
    }
    handleRequest(request).catch((err) => {
      if (request.id !== undefined && request.id !== null) sendError(request.id, -32603, err.message);
    });
  }
});
process.stdin.on('end', () => process.exit(0));
