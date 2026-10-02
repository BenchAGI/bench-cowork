#!/usr/bin/env node
/**
 * op-guard — run a 1Password `op` command from an UNATTENDED job without letting it wedge the box.
 *
 *   op-guard [--timeout-s 15] [--key NAME] [--state-dir DIR] [--backoff-base-s 30] [--backoff-max-s 1800] -- op read 'op://Vault/Item/field'
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
 *
 * It never reads, logs, or stores a secret. The command's stdout/stderr pass straight through.
 * Breaker state holds only a count and a timestamp, in a 0700 dir.
 *
 * Exit codes: the command's own code on a normal exit; 124 = timed out and killed;
 * 75 = breaker open (the command was NOT run); 2 = usage error.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const EXIT_TIMEOUT = 124;
export const EXIT_BREAKER_OPEN = 75;

export function parseArgs(argv) {
  const sep = argv.indexOf('--');
  if (sep === -1 || sep === argv.length - 1) return { error: 'usage: op-guard [options] -- <command> [args...]' };
  const options = {
    timeoutS: 15,
    key: null,
    stateDir: path.join(os.homedir(), '.cache', 'bench-op-guard'),
    backoffBaseS: 30,
    backoffMaxS: 1800,
  };
  const flags = argv.slice(0, sep);
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    const value = flags[i + 1];
    const number = Number(value);
    if (flag === '--timeout-s' && Number.isFinite(number) && number > 0) options.timeoutS = number;
    else if (flag === '--backoff-base-s' && Number.isFinite(number) && number > 0) options.backoffBaseS = number;
    else if (flag === '--backoff-max-s' && Number.isFinite(number) && number > 0) options.backoffMaxS = number;
    else if (flag === '--key' && value) options.key = value;
    else if (flag === '--state-dir' && value) options.stateDir = value;
    else return { error: `unknown or invalid option: ${flag}` };
    i += 1;
  }
  return { options, command: argv.slice(sep + 1) };
}

/** One breaker per key; the default key is a hash of the command line (op:// references are not secrets). */
export function breakerPath(options, command) {
  const key = options.key ?? createHash('sha256').update(command.join('\u0000')).digest('hex').slice(0, 16);
  return path.join(options.stateDir, `${key.replace(/[^A-Za-z0-9._-]/gu, '_')}.json`);
}

export function readBreaker(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { failures: Number(state.failures) || 0, openUntilMs: Number(state.openUntilMs) || 0 };
  } catch {
    return { failures: 0, openUntilMs: 0 };
  }
}

function writeBreaker(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
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

const SIGNAL_EXIT = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

export async function run(argv, env = process.env) {
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
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', detached: true, env: { ...env, [RUN_MARKER]: runId } });
  let abortReason = null; // 'timeout' or a signal name
  let cleanup = null;
  let descendants = new Set();
  const abort = (reason) => {
    if (abortReason) return;
    abortReason = reason;
    descendants = descendantsOf(psSnapshot(), child.pid);
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
      resolve({ code: 127 });
    });
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  if (cleanup) await cleanup;
  for (const [name, handler] of handlers) process.off(name, handler);

  const failed = abortReason !== null || result.code !== 0;
  if (failed) {
    // A killed or failed `op` can leave a daemon in a session of its own; clear only what this run created.
    if (abortReason === null) descendants = new Set();
    sweepOwned(runId, descendants);
    const failures = breaker.failures + 1;
    writeBreaker(file, {
      failures,
      openUntilMs: Date.now() + nextBackoffMs(failures, options),
      lastFailureAt: new Date().toISOString(),
      timedOut: abortReason === 'timeout',
      ...(abortReason && abortReason !== 'timeout' ? { cancelledBy: abortReason } : {}),
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
  if (breaker.failures > 0) writeBreaker(file, { failures: 0, openUntilMs: 0, recoveredAt: new Date().toISOString() });
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
