#!/usr/bin/env node
/**
 * op-guard — run a 1Password `op` command from an UNATTENDED job without letting it wedge the box.
 *
 *   op-guard [--timeout-s 15] [--key NAME] [--state-dir DIR] [--backoff-base-s 30] [--backoff-max-s 1800]
 *            [--probe-host HOST[:PORT]] [--no-probe] -- op read 'op://Vault/Item/field'
 *   op-guard status --max-age-s N [--key NAME]... [--state-dir DIR]
 *
 * Why it exists (Remedy, 2026-10-01): a scheduled lead-intake job called `op read` every 2 minutes.
 * When `op` hung, the job's 15 s timeout killed the `op` client but not the `op daemon --background`
 * it had spawned, so orphans piled up (40 in 16 minutes) and every run was a fresh hang with no pause.
 *
 * What it does:
 *   1. Runs the command in its own process group and, on timeout, kills the whole group.
 *   2. After a failure, timeout or cancellation, kills what THIS run provably started and left behind
 *      (a daemon that detached into its own session): processes carrying this run's unique
 *      OP_GUARD_RUN marker in their environment, or still descended from the command. It never
 *      selects by name, age or parent, so an `op daemon` from another job is left alone.
 *   2b. A timeout waits for the group to be gone (SIGTERM, then SIGKILL after 2 s) before returning.
 *   2c. SIGTERM / SIGINT / SIGHUP sent to the guard are forwarded to the owned group, cleaned up the
 *       same way, and recorded as a failed run (exit 128+signal).
 *   3. Circuit breaker: after a failure or timeout it refuses to call `op` again until a backoff
 *      expires (30 s, 60 s, 120 s ... capped), printing why. A success closes the breaker.
 *   4. Evidence (follow-up to #9031: Remedy's reads failed the morning after an idle night, root cause open).
 *      Every success records lastSuccessAt; every failure records lastFailure: the cause, how long the credential
 *      had been idle, whether a service-account token was set, `op`'s process state when it hung, and (on a
 *      timeout) whether 1Password's edge answered DNS and TCP at that moment. A later success keeps lastFailure.
 *   5. `op-guard status --max-age-s N` answers "was this credential actually read successfully within N seconds?"
 *      from that state, so a scheduler that is alive is not mistaken for a credential that is ready.
 *
 * It never reads, logs, or stores a secret. The command's stdout/stderr pass straight through.
 * State holds counts, timestamps, closed-vocabulary labels and process states (never a command line or an
 * environment), written atomically in a 0700 dir. A state write that fails never changes the command's result.
 *
 * Exit codes: the command's own code on a normal exit; 124 = timed out and killed;
 * 75 = breaker open (the command was NOT run); 2 = usage error.
 * `status`: 0 = every key verified within the age; 75 = a key's last read failed or its breaker is open;
 * 76 = a key was never verified or its last success is older than the age (or no state exists at all).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const EXIT_TIMEOUT = 124;
export const EXIT_BREAKER_OPEN = 75;
export const EXIT_UNVERIFIED = 76;
/** Where the reachability probe aims by default: 1Password's public edge. It says only that this host reached that endpoint, not that the account host or `op`'s own path did. */
export const DEFAULT_PROBE = Object.freeze({ host: 'my.1password.com', port: 443 });
const PROBE_TIMEOUT_MS = 3000;
const DEFAULT_STATE_DIR = path.join(os.homedir(), '.cache', 'bench-op-guard');

export function parseArgs(argv) {
  const sep = argv.indexOf('--');
  if (sep === -1 || sep === argv.length - 1) return { error: 'usage: op-guard [options] -- <command> [args...]' };
  const options = {
    timeoutS: 15,
    key: null,
    stateDir: DEFAULT_STATE_DIR,
    backoffBaseS: 30,
    backoffMaxS: 1800,
    probe: DEFAULT_PROBE,
  };
  const flags = argv.slice(0, sep);
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    if (flag === '--no-probe') {
      options.probe = null;
      continue;
    }
    const value = flags[i + 1];
    const number = Number(value);
    if (flag === '--timeout-s' && Number.isFinite(number) && number > 0) options.timeoutS = number;
    else if (flag === '--backoff-base-s' && Number.isFinite(number) && number > 0) options.backoffBaseS = number;
    else if (flag === '--backoff-max-s' && Number.isFinite(number) && number > 0) options.backoffMaxS = number;
    else if (flag === '--key' && value) options.key = value;
    else if (flag === '--state-dir' && value) options.stateDir = value;
    else if (flag === '--probe-host') {
      const target = parseProbeTarget(value ?? '');
      if (!target) return { error: 'invalid --probe-host (expected HOST or HOST:PORT)' };
      options.probe = target;
    } else return { error: `unknown or invalid option: ${flag}` };
    i += 1;
  }
  return { options, command: argv.slice(sep + 1) };
}

/** `HOST` or `HOST:PORT` (443 by default). Hostnames and IPv4 only: this is a TCP-connect target, not a URL. */
export function parseProbeTarget(value) {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::(\d{1,5}))?$/u.exec(value);
  if (!match) return null;
  const port = match[2] ? Number(match[2]) : 443;
  return port >= 1 && port <= 65535 ? { host: match[1], port } : null;
}

function stateFile(stateDir, key) {
  return path.join(stateDir, `${key.replace(/[^A-Za-z0-9._-]/gu, '_')}.json`);
}

/** One breaker per key; the default key is a hash of the command line (op:// references are not secrets). */
export function breakerPath(options, command) {
  const key = options.key ?? createHash('sha256').update(command.join('\u0000')).digest('hex').slice(0, 16);
  return stateFile(options.stateDir, key);
}

const isoOrNull = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null);
const finiteOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const labelOrNull = (value) => (typeof value === 'string' && /^[A-Za-z0-9._:-]{1,64}$/u.test(value) ? value : null);

/** Only the fields this guard writes, each type-checked, so a hand-edited or damaged file cannot inject anything into `status`. */
function readFailure(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const network = raw.network && typeof raw.network === 'object'
    ? {
        host: labelOrNull(raw.network.host),
        port: finiteOrNull(raw.network.port),
        dns: labelOrNull(raw.network.dns),
        connect: labelOrNull(raw.network.connect),
        ms: finiteOrNull(raw.network.ms),
      }
    : null;
  return {
    at: isoOrNull(raw.at),
    cause: labelOrNull(raw.cause),
    elapsedMs: finiteOrNull(raw.elapsedMs),
    idleS: finiteOrNull(raw.idleS),
    exitCode: finiteOrNull(raw.exitCode),
    signal: labelOrNull(raw.signal),
    auth: labelOrNull(raw.auth),
    opCache: labelOrNull(raw.opCache),
    opProcessStates: Array.isArray(raw.opProcessStates) ? raw.opProcessStates.filter((s) => typeof s === 'string' && /^[A-Za-z]$/u.test(s)) : null,
    network,
  };
}

export function readBreaker(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      failures: Number(state.failures) || 0,
      openUntilMs: Number(state.openUntilMs) || 0,
      lastSuccessAt: isoOrNull(state.lastSuccessAt),
      lastFailure: readFailure(state.lastFailure),
    };
  } catch {
    return { failures: 0, openUntilMs: 0, lastSuccessAt: null, lastFailure: null };
  }
}

/** Best effort and atomic: a reader never sees half a file, and a full disk or read-only dir never changes the command's result. */
function writeBreaker(file, state) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    process.stderr.write(`op-guard: could not record state in ${path.dirname(file)} (${error.code ?? 'error'}); the command's result is unchanged\n`);
    return false;
  }
}

export function nextBackoffMs(failures, options) {
  return Math.min(options.backoffBaseS * 2 ** Math.max(0, failures - 1), options.backoffMaxS) * 1000;
}

const RUN_MARKER = 'OP_GUARD_RUN';

function psSnapshot() {
  // -E appends each process's environment to its command (own-user processes only).
  return spawnSync('ps', ['-axwwE', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout ?? '';
}

function parsePs(psText) {
  const rows = [];
  for (const line of psText.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/u);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return rows;
}

/** Pids below `rootPid` in the ppid tree (root excluded). */
export function descendantsOf(psText, rootPid) {
  const rows = parsePs(psText);
  const found = new Set();
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const row of rows) {
      if (row.ppid === parent && !found.has(row.pid)) {
        found.add(row.pid);
        queue.push(row.pid);
      }
    }
  }
  return found;
}

/**
 * Processes this run owns: carry its unique run marker in their environment. Name, age and parent
 * are never consulted, so another job's `op daemon` (or one that predates this run) is never selected.
 */
export function findMarkedProcesses(psText, runId, selfPid = process.pid) {
  const marker = new RegExp(`(^|\\s)${RUN_MARKER}=${runId.replace(/[^A-Za-z0-9-]/gu, '')}(\\s|$)`, 'u');
  return parsePs(psText).filter((row) => row.pid !== selfPid && marker.test(row.command)).map((row) => row.pid);
}

function killGroup(pid, signal) {
  try { process.kill(-pid, signal); } catch { /* already gone */ }
}

function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitGroupGone(pid, ms) {
  const deadline = Date.now() + ms;
  while (groupAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
  return true;
}

/** SIGTERM the owned group, SIGKILL whatever ignores it, and only return once the group is gone. */
async function terminateGroup(pid) {
  killGroup(pid, 'SIGTERM');
  if (await waitGroupGone(pid, 2000)) return;
  killGroup(pid, 'SIGKILL');
  await waitGroupGone(pid, 2000);
}

/** Kill owned stragglers that left the group (e.g. a daemon in its own session). `descendants` was snapshotted before the kill. */
function sweepOwned(runId, descendants) {
  const text = psSnapshot();
  const alive = new Set(parsePs(text).map((row) => row.pid));
  const owned = new Set([...findMarkedProcesses(text, runId), ...[...descendants].filter((pid) => alive.has(pid))]);
  owned.delete(process.pid);
  for (const pid of owned) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  return owned.size;
}

/**
 * One-letter kernel states (R running, S sleeping, U uninterruptible, ...) of the given pids, deduped and sorted.
 * Asked for pids only: no command line and no environment, so nothing secret can reach the state file.
 * A hung `op` that is S is waiting on a socket or a lock; U is stuck in the kernel (a file or privacy prompt).
 */
export function processStates(pids) {
  if (pids.length === 0) return [];
  const out = spawnSync('ps', ['-o', 'state=', '-p', pids.join(',')], { encoding: 'utf8' }).stdout ?? '';
  const letters = out.split('\n').map((line) => line.trim().charAt(0)).filter((letter) => /^[A-Za-z]$/u.test(letter));
  return [...new Set(letters)].sort();
}

const TIMED_OUT = Symbol('timed-out');

function raceTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function connectOnce(address, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: address, port });
    let timer = null;
    const done = (outcome) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    timer = setTimeout(() => done('timeout'), timeoutMs);
    socket.once('connect', () => done('ok'));
    socket.once('error', () => done('failed'));
  });
}

/**
 * Did DNS and a bare TCP connect to `target` succeed, right now? Sends no data. Answers one question for the
 * incident record: when `op` hung, could this host resolve and connect to the selected endpoint?
 * This does not prove that the account-specific endpoint or `op`'s own path was reachable.
 * Every outcome is one of ok | failed | timeout | skipped; it never throws.
 */
export async function probeReachability(target, { timeoutMs = PROBE_TIMEOUT_MS, lookup = (host) => dns.lookup(host) } = {}) {
  const started = Date.now();
  const result = { host: target.host, port: target.port, dns: 'failed', connect: 'skipped', ms: 0 };
  try {
    const answer = await raceTimeout(Promise.resolve().then(() => lookup(target.host)), timeoutMs);
    if (answer === TIMED_OUT) {
      result.dns = 'timeout';
    } else {
      result.dns = 'ok';
      result.connect = await connectOnce(answer.address, target.port, Math.max(250, timeoutMs - (Date.now() - started)));
    }
  } catch {
    result.dns = 'failed';
  }
  result.ms = Date.now() - started;
  return result;
}

function failureCause(abortReason, result) {
  if (abortReason === 'timeout') return 'timeout';
  if (abortReason) return 'cancelled';
  return result.notStarted ? 'not-started' : 'exit';
}

const SIGNAL_EXIT = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

export async function run(argv, env = process.env) {
  if (argv[0] === 'status') return runStatus(argv.slice(1));
  const parsed = parseArgs(argv);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }
  const { options, command } = parsed;
  const file = breakerPath(options, command);
  const breaker = readBreaker(file);
  const now = Date.now();
  if (breaker.openUntilMs > now) {
    const wait = Math.ceil((breaker.openUntilMs - now) / 1000);
    process.stderr.write(
      `op-guard: breaker open after ${breaker.failures} failure(s); not calling ${path.basename(command[0])} for another ${wait}s ` +
        `(until ${new Date(breaker.openUntilMs).toISOString()})\n`,
    );
    return EXIT_BREAKER_OPEN;
  }

  const runId = randomUUID();
  const startedMs = Date.now();
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', detached: true, env: { ...env, [RUN_MARKER]: runId } });
  let abortReason = null; // 'timeout' or a signal name
  let cleanup = null;
  let descendants = new Set();
  let opProcessStates = null;
  let probing = null;
  const abort = (reason) => {
    if (abortReason) return;
    abortReason = reason;
    descendants = descendantsOf(psSnapshot(), child.pid);
    if (reason === 'timeout') {
      // Evidence is taken at the moment of the hang, before the kill, and the probe runs alongside it.
      opProcessStates = processStates([child.pid, ...descendants]);
      if (options.probe) probing = probeReachability(options.probe);
    }
    cleanup = terminateGroup(child.pid);
  };
  const handlers = Object.keys(SIGNAL_EXIT).map((name) => {
    const handler = () => abort(name);
    process.on(name, handler);
    return [name, handler];
  });
  const timer = setTimeout(() => abort('timeout'), options.timeoutS * 1000);
  const result = await new Promise((resolve) => {
    child.on('error', (error) => {
      process.stderr.write(`op-guard: could not start ${command[0]}: ${error.message}\n`);
      resolve({ code: 127, notStarted: true });
    });
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  if (cleanup) await cleanup;
  const network = probing ? await probing : null;
  for (const [name, handler] of handlers) process.off(name, handler);

  const failed = abortReason !== null || result.code !== 0;
  if (failed) {
    // A killed or failed `op` can leave a daemon in a session of its own; clear only what this run created.
    if (abortReason === null) descendants = new Set();
    sweepOwned(runId, descendants);
    const failures = breaker.failures + 1;
    const failedAt = new Date().toISOString();
    writeBreaker(file, {
      failures,
      openUntilMs: Date.now() + nextBackoffMs(failures, options),
      lastFailureAt: failedAt,
      timedOut: abortReason === 'timeout',
      ...(abortReason && abortReason !== 'timeout' ? { cancelledBy: abortReason } : {}),
      ...(breaker.lastSuccessAt ? { lastSuccessAt: breaker.lastSuccessAt } : {}),
      lastFailure: {
        at: failedAt,
        cause: failureCause(abortReason, result),
        elapsedMs: Date.now() - startedMs,
        // Seconds between the last successful read and the start of this one: the "after idle" hypothesis, measured.
        idleS: breaker.lastSuccessAt ? Math.max(0, Math.round((startedMs - Date.parse(breaker.lastSuccessAt)) / 1000)) : null,
        exitCode: result.code ?? null,
        signal: result.signal ?? null,
        auth: env.OP_SERVICE_ACCOUNT_TOKEN ? 'service-account' : 'no-service-account-token',
        opCache: env.OP_CACHE === undefined ? 'unset' : ['true', 'false'].includes(env.OP_CACHE) ? env.OP_CACHE : 'other',
        ...(opProcessStates ? { opProcessStates } : {}),
        ...(network ? { network } : {}),
      },
    });
    if (abortReason === 'timeout') {
      process.stderr.write(`op-guard: ${path.basename(command[0])} exceeded ${options.timeoutS}s; killed the process group and anything it left behind\n`);
      return EXIT_TIMEOUT;
    }
    if (abortReason) {
      process.stderr.write(`op-guard: received ${abortReason}; stopped ${path.basename(command[0])} and cleaned up\n`);
      return SIGNAL_EXIT[abortReason];
    }
    return result.code ?? 1;
  }
  const succeededAt = new Date().toISOString();
  writeBreaker(file, {
    failures: 0,
    openUntilMs: 0,
    lastSuccessAt: succeededAt,
    ...(breaker.failures > 0 ? { recoveredAt: succeededAt } : {}),
    // The failure that opened the breaker stays on record after a later success: it is the evidence.
    ...(breaker.lastFailure ? { lastFailure: breaker.lastFailure } : {}),
  });
  return 0;
}

/** Verdict for one key. `failing` = the latest read failed and its backoff has elapsed, with no success since. */
export function keyVerdict(key, state, maxAgeS, nowMs) {
  const lastSuccessMs = state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : NaN;
  const verifiedAgeS = Number.isFinite(lastSuccessMs) ? Math.max(0, Math.round((nowMs - lastSuccessMs) / 1000)) : null;
  let verdict;
  if (state.failures > 0) verdict = state.openUntilMs > nowMs ? 'breaker-open' : 'failing';
  else if (verifiedAgeS === null) verdict = 'never-verified';
  else if (verifiedAgeS > maxAgeS) verdict = 'stale';
  else verdict = 'verified';
  return {
    key,
    state: verdict,
    verifiedAgeS,
    lastSuccessAt: state.lastSuccessAt,
    failures: state.failures,
    retryInS: state.openUntilMs > nowMs ? Math.ceil((state.openUntilMs - nowMs) / 1000) : 0,
    lastFailure: state.lastFailure,
  };
}

export function statusExitCode(verdicts) {
  if (verdicts.some((v) => v.state === 'breaker-open' || v.state === 'failing')) return EXIT_BREAKER_OPEN;
  if (verdicts.length === 0 || verdicts.some((v) => v.state !== 'verified')) return EXIT_UNVERIFIED;
  return 0;
}

export function parseStatusArgs(argv) {
  const usage = 'usage: op-guard status --max-age-s N [--key NAME]... [--state-dir DIR]';
  const options = { stateDir: DEFAULT_STATE_DIR, keys: [], maxAgeS: null };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    const number = Number(value);
    if (flag === '--max-age-s' && Number.isFinite(number) && number > 0) options.maxAgeS = number;
    else if (flag === '--key' && value) options.keys.push(value);
    else if (flag === '--state-dir' && value) options.stateDir = value;
    else return { error: `unknown or invalid option: ${flag}\n${usage}` };
  }
  return options.maxAgeS === null ? { error: usage } : { options };
}

/**
 * Read-only: never runs `op`, never writes. `--max-age-s` is required on purpose: a credential check
 * with no expiry is the cached preflight that hid this failure for three nights. Prints JSON on stdout.
 */
export function runStatus(argv, nowMs = Date.now()) {
  const parsed = parseStatusArgs(argv);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }
  const { options } = parsed;
  let keys = options.keys;
  if (keys.length === 0) {
    try {
      keys = fs.readdirSync(options.stateDir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)).sort();
    } catch {
      keys = [];
    }
  }
  const verdicts = keys.map((key) => keyVerdict(key, readBreaker(stateFile(options.stateDir, key)), options.maxAgeS, nowMs));
  process.stdout.write(`${JSON.stringify({ maxAgeS: options.maxAgeS, checkedAt: new Date(nowMs).toISOString(), keys: verdicts }, null, 2)}\n`);
  return statusExitCode(verdicts);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
