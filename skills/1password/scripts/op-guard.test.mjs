import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import net from 'node:net';

import {
  DEFAULT_PROBE,
  descendantsOf,
  findMarkedProcesses,
  keyVerdict,
  nextBackoffMs,
  parseArgs,
  parseProbeTarget,
  parseStatusArgs,
  probeReachability,
  statusExitCode,
} from './op-guard.mjs';

const GUARD = path.join(path.dirname(new URL(import.meta.url).pathname), 'op-guard.mjs');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-guard-'));
  return { dir, state: path.join(dir, 'state'), marker: path.join(dir, 'ran') };
}

/** The caller's environment minus anything 1Password, so a developer's real token never leaks into a case. */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('OP_')) delete env[name];
  return { ...env, ...extra };
}

/** Probing is off unless a case asks for it with `probe: 'host:port'`, so no case depends on real DNS or the network. */
function guard(box, args, { timeoutMs = 20000, env = cleanEnv(), probe = null } = {}) {
  const probeFlags = probe ? ['--probe-host', probe] : ['--no-probe'];
  return spawnSync(process.execPath, [GUARD, '--state-dir', box.state, '--key', 't', ...probeFlags, ...args], { encoding: 'utf8', timeout: timeoutMs, env });
}

function status(box, args) {
  const out = spawnSync(process.execPath, [GUARD, 'status', '--state-dir', box.state, ...args], { encoding: 'utf8', timeout: 20000, env: cleanEnv() });
  let json = null;
  try { json = JSON.parse(out.stdout); } catch { /* usage errors print no JSON */ }
  return { code: out.status, json, stderr: out.stderr, stdout: out.stdout };
}

function seed(box, key, state) {
  fs.mkdirSync(box.state, { recursive: true });
  fs.writeFileSync(path.join(box.state, `${key}.json`), JSON.stringify(state));
}

const ago = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();
const readState = (box, key = 't') => JSON.parse(fs.readFileSync(path.join(box.state, `${key}.json`), 'utf8'));

function script(box, name, body) {
  const file = path.join(box.dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

test('a successful command passes its output through, closes the breaker and records the read', () => {
  const box = sandbox();
  const op = script(box, 'op-ok', 'echo VALUE-THAT-IS-NOT-LOGGED; exit 0');
  const before = Date.now();
  const out = guard(box, ['--', op]);
  assert.equal(out.status, 0);
  assert.equal(out.stdout.trim(), 'VALUE-THAT-IS-NOT-LOGGED');
  const state = readState(box);
  assert.equal(state.failures, 0);
  assert.equal(state.openUntilMs, 0);
  assert.ok(Date.parse(state.lastSuccessAt) >= before - 1000 && Date.parse(state.lastSuccessAt) <= Date.now() + 1000);
  assert.equal('lastFailure' in state, false);
  assert.equal(JSON.stringify(state).includes('VALUE-THAT-IS-NOT-LOGGED'), false);
});

test('a hang is killed with its whole process group, exits 124, and opens the breaker', () => {
  const box = sandbox();
  const childPidFile = path.join(box.dir, 'child.pid');
  const op = script(box, 'op-hang', `sleep 300 & echo $! > ${childPidFile}; wait`);
  const out = guard(box, ['--timeout-s', '1', '--', op]);
  assert.equal(out.status, 124);
  const childPid = Number(fs.readFileSync(childPidFile, 'utf8'));
  let alive = true;
  try { process.kill(childPid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'the grandchild must die with the group');
  const state = JSON.parse(fs.readFileSync(path.join(box.state, 't.json'), 'utf8'));
  assert.equal(state.failures, 1);
  assert.ok(state.openUntilMs > Date.now());
});

test('an open breaker refuses to run the command at all', () => {
  const box = sandbox();
  const op = script(box, 'op-mark', `touch ${box.marker}`);
  fs.mkdirSync(box.state, { recursive: true });
  fs.writeFileSync(path.join(box.state, 't.json'), JSON.stringify({ failures: 3, openUntilMs: Date.now() + 60_000 }));
  const out = guard(box, ['--', op]);
  assert.equal(out.status, 75);
  assert.match(out.stderr, /breaker open after 3 failure/u);
  assert.equal(fs.existsSync(box.marker), false);
});

test('after the backoff expires the command runs and a success closes the breaker', () => {
  const box = sandbox();
  const op = script(box, 'op-ok2', 'exit 0');
  fs.mkdirSync(box.state, { recursive: true });
  fs.writeFileSync(path.join(box.state, 't.json'), JSON.stringify({ failures: 4, openUntilMs: Date.now() - 1000 }));
  const out = guard(box, ['--', op]);
  assert.equal(out.status, 0);
  const state = JSON.parse(fs.readFileSync(path.join(box.state, 't.json'), 'utf8'));
  assert.equal(state.failures, 0);
  assert.equal(state.openUntilMs, 0);
});

test('a non-zero exit passes through and counts as a failure', () => {
  const box = sandbox();
  const op = script(box, 'op-fail', 'exit 9');
  const out = guard(box, ['--', op]);
  assert.equal(out.status, 9);
  assert.equal(JSON.parse(fs.readFileSync(path.join(box.state, 't.json'), 'utf8')).failures, 1);
});

test('breaker state holds no command output or secret material', () => {
  const box = sandbox();
  const op = script(box, 'op-secret', 'echo SECRET-ABC123; exit 1');
  guard(box, ['--', op]);
  const raw = fs.readFileSync(path.join(box.state, 't.json'), 'utf8');
  assert.equal(raw.includes('SECRET-ABC123'), false);
  assert.equal(fs.statSync(path.join(box.state, 't.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(box.state).mode & 0o777, 0o700);
});

test('backoff doubles and is capped', () => {
  const options = { backoffBaseS: 30, backoffMaxS: 1800 };
  assert.deepEqual([1, 2, 3, 4, 10].map((n) => nextBackoffMs(n, options) / 1000), [30, 60, 120, 240, 1800]);
});

const RUN = '11111111-2222-3333-4444-555555555555';

test('ownership is the run marker, never name, age or parent', () => {
  const ps = [
    // pre-existing daemon, parent 1, younger than the run would be: the reviewer's repro. Not ours.
    '  999     1 /opt/homebrew/bin/op daemon --background HOME=/Users/x',
    // another job's daemon carrying a different run id. Not ours.
    `  998     1 /opt/homebrew/bin/op daemon --background OP_GUARD_RUN=aaaaaaaa-0000-0000-0000-000000000000 HOME=/Users/x`,
    // ours, detached into its own session
    `  997     1 /opt/homebrew/bin/op daemon --background HOME=/Users/x OP_GUARD_RUN=${RUN} PATH=/bin`,
    // run id that merely starts with ours must not match
    `  996     1 /usr/bin/thing OP_GUARD_RUN=${RUN}-extra`,
  ].join('\n');
  assert.deepEqual(findMarkedProcesses(ps, RUN, 1), [997]);
  assert.deepEqual(findMarkedProcesses(ps, RUN, 997), []);
});

test('descendants are found through the ppid tree', () => {
  const ps = ['  10   1 root', '  11  10 child', '  12  11 grandchild', '  13   1 stranger', '  14  13 stranger-child'].join('\n');
  assert.deepEqual([...descendantsOf(ps, 10)].sort(), [11, 12]);
});

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(predicate, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

test('a failed run kills the daemon it left in its own session, and not an unrelated one', async () => {
  const box = sandbox();
  const daemonPidFile = path.join(box.dir, 'daemon.pid');
  const op = path.join(box.dir, 'op-leaves-daemon.mjs');
  fs.writeFileSync(
    op,
    `#!${process.execPath}\n` +
      `import { spawn } from 'node:child_process';\nimport fs from 'node:fs';\n` +
      `const d = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });\n` +
      `d.unref();\nfs.writeFileSync(${JSON.stringify(daemonPidFile)}, String(d.pid));\nprocess.exit(1);\n`,
    { mode: 0o755 },
  );
  // An unrelated long-lived process: started before the run, in its own session, no guard marker.
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  bystander.unref();
  try {
    const out = guard(box, ['--', op]);
    assert.equal(out.status, 1);
    const daemonPid = Number(fs.readFileSync(daemonPidFile, 'utf8'));
    assert.equal(await waitFor(() => !alive(daemonPid)), true, 'the daemon this run created must be killed');
    assert.equal(alive(bystander.pid), true, 'a process this run did not create must survive');
  } finally {
    try { process.kill(bystander.pid, 'SIGKILL'); } catch { /* gone */ }
  }
});

test('a SIGTERM-resistant descendant is SIGKILLed even when the leader exits on SIGTERM', () => {
  const box = sandbox();
  const stubbornPidFile = path.join(box.dir, 'stubborn.pid');
  const op = script(
    box,
    'op-stubborn',
    `sh -c 'trap "" TERM; echo $$ > ${stubbornPidFile}; while :; do sleep 1; done' &\n` +
      `trap 'exit 0' TERM\nwait`,
  );
  const out = guard(box, ['--timeout-s', '1', '--', op]);
  assert.equal(out.status, 124);
  const stubbornPid = Number(fs.readFileSync(stubbornPidFile, 'utf8'));
  assert.equal(alive(stubbornPid), false, 'the guard must not return while a group member survives');
});

test('SIGTERM to the guard stops the owned group, records a failure, and exits 143', async () => {
  const box = sandbox();
  const pidFile = path.join(box.dir, 'long.pid');
  const op = script(box, 'op-long', `sleep 300 & echo $! > ${pidFile}; wait`);
  const guardProc = spawn(process.execPath, [GUARD, '--state-dir', box.state, '--key', 't', '--timeout-s', '60', '--', op], { stdio: 'ignore' });
  const exited = new Promise((resolve) => guardProc.on('close', (code) => resolve(code)));
  const childPid = Number(await waitFor(() => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : null)));
  assert.ok(childPid > 0, 'guarded command should have started');
  guardProc.kill('SIGTERM');
  assert.equal(await exited, 143);
  assert.equal(alive(childPid), false, 'the guarded command must not outlive a cancelled guard');
  const state = JSON.parse(fs.readFileSync(path.join(box.state, 't.json'), 'utf8'));
  assert.equal(state.failures, 1);
  assert.equal(state.cancelledBy, 'SIGTERM');
});

test('usage errors', () => {
  assert.match(parseArgs(['--timeout-s', '5']).error, /usage/u);
  assert.match(parseArgs(['--bogus', '1', '--', 'op']).error, /unknown/u);
  assert.equal(parseArgs(['--timeout-s', '7', '--', 'op', 'read', 'x']).options.timeoutS, 7);
});

// --- #9031: evidence recorded on every run, and `status` for "was this credential really read lately?" ---

test('a failed run records why: cause, idle time since the last read, auth mode, and keeps the last success', () => {
  const box = sandbox();
  const lastSuccessAt = ago(7200);
  seed(box, 't', { failures: 0, openUntilMs: 0, lastSuccessAt });
  const op = script(box, 'op-fail9', 'exit 9');
  const out = guard(box, ['--', op], { env: cleanEnv({ OP_SERVICE_ACCOUNT_TOKEN: 'ops_SECRET-TOKEN-VALUE', OP_CACHE: 'false' }) });
  assert.equal(out.status, 9);
  const state = readState(box);
  assert.equal(state.lastSuccessAt, lastSuccessAt, 'a failure must not erase when the credential last worked');
  assert.equal(state.lastFailure.cause, 'exit');
  assert.equal(state.lastFailure.exitCode, 9);
  assert.ok(Math.abs(state.lastFailure.idleS - 7200) < 30, `idleS was ${state.lastFailure.idleS}`);
  assert.equal(state.lastFailure.auth, 'service-account');
  assert.equal(state.lastFailure.opCache, 'false');
  assert.equal('network' in state.lastFailure, false, 'only a timeout probes the network');
  assert.equal(JSON.stringify(state).includes('SECRET-TOKEN-VALUE'), false, 'the token value must never reach the state file');
});

test('without a service-account token, and with OP_CACHE unset, the record says so', () => {
  const box = sandbox();
  const op = script(box, 'op-fail1', 'exit 1');
  guard(box, ['--', op]);
  const { lastFailure } = readState(box);
  assert.equal(lastFailure.auth, 'no-service-account-token');
  assert.equal(lastFailure.opCache, 'unset');
  assert.equal(lastFailure.idleS, null, 'no earlier success on record');
});

test('a command that cannot start is recorded as not-started', () => {
  const box = sandbox();
  const out = guard(box, ['--', path.join(box.dir, 'no-such-op')]);
  assert.equal(out.status, 127);
  assert.equal(readState(box).lastFailure.cause, 'not-started');
});

async function listening() {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('a hang records the process state it died in and that the network path answered', async () => {
  const box = sandbox();
  const server = await listening();
  try {
    const { port } = server.address();
    const op = script(box, 'op-hang2', 'sleep 300 & wait');
    const out = guard(box, ['--timeout-s', '1', '--', op], { probe: `127.0.0.1:${port}` });
    assert.equal(out.status, 124);
    const { lastFailure } = readState(box);
    assert.equal(lastFailure.cause, 'timeout');
    assert.ok(lastFailure.elapsedMs >= 900, `elapsedMs was ${lastFailure.elapsedMs}`);
    assert.ok(Array.isArray(lastFailure.opProcessStates) && lastFailure.opProcessStates.length > 0);
    assert.ok(lastFailure.opProcessStates.every((letter) => /^[A-Za-z]$/u.test(letter)), 'one-letter kernel states only, never a command line');
    assert.deepEqual({ ...lastFailure.network, ms: 0 }, { host: '127.0.0.1', port, dns: 'ok', connect: 'ok', ms: 0 });
  } finally {
    server.close();
  }
});

test('a hang while nothing answers records the connect as failed', async () => {
  const box = sandbox();
  const server = await listening();
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  const op = script(box, 'op-hang3', 'sleep 300 & wait');
  const out = guard(box, ['--timeout-s', '1', '--', op], { probe: `127.0.0.1:${port}` });
  assert.equal(out.status, 124);
  const { network } = readState(box).lastFailure;
  assert.equal(network.dns, 'ok');
  assert.equal(network.connect, 'failed');
});

test('--no-probe skips the network probe but still records the process state', () => {
  const box = sandbox();
  const op = script(box, 'op-hang4', 'sleep 300 & wait');
  const out = guard(box, ['--timeout-s', '1', '--', op]);
  assert.equal(out.status, 124);
  const { lastFailure } = readState(box);
  assert.equal('network' in lastFailure, false);
  assert.ok(lastFailure.opProcessStates.length > 0);
});

test('the probe never throws: a failing resolver is dns failed, a silent one is a timeout', async () => {
  const target = { host: 'op.test', port: 443 };
  const failing = await probeReachability(target, { lookup: async () => { throw new Error('ENOTFOUND'); } });
  assert.deepEqual({ ...failing, ms: 0 }, { host: 'op.test', port: 443, dns: 'failed', connect: 'skipped', ms: 0 });
  const silent = await probeReachability(target, { timeoutMs: 40, lookup: () => new Promise(() => {}) });
  assert.equal(silent.dns, 'timeout');
  assert.equal(silent.connect, 'skipped');
});

test('a failure record survives the later success that closes the breaker', () => {
  const box = sandbox();
  seed(box, 't', {
    failures: 2,
    openUntilMs: Date.now() - 1000,
    lastSuccessAt: ago(40000),
    lastFailure: { at: ago(600), cause: 'timeout', idleS: 39000, auth: 'service-account', opProcessStates: ['S'], network: { host: 'my.1password.com', port: 443, dns: 'ok', connect: 'ok', ms: 12 } },
  });
  const op = script(box, 'op-ok3', 'exit 0');
  assert.equal(guard(box, ['--', op]).status, 0);
  const state = readState(box);
  assert.equal(state.failures, 0);
  assert.ok(state.recoveredAt);
  assert.ok(Date.now() - Date.parse(state.lastSuccessAt) < 10000);
  assert.equal(state.lastFailure.cause, 'timeout');
  assert.equal(state.lastFailure.idleS, 39000);
  assert.deepEqual(state.lastFailure.opProcessStates, ['S']);
  assert.equal(state.lastFailure.network.connect, 'ok');
});

test('a state directory that cannot be written never changes the command result', () => {
  const box = sandbox();
  const blocker = path.join(box.dir, 'a-file');
  fs.writeFileSync(blocker, 'not a directory');
  const unwritable = { ...box, state: path.join(blocker, 'state') };
  const ok = guard(unwritable, ['--', script(box, 'op-ok4', 'echo VALUE; exit 0')]);
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), 'VALUE');
  assert.match(ok.stderr, /could not record state/u);
  const failed = guard(unwritable, ['--', script(box, 'op-fail5', 'exit 9')]);
  assert.equal(failed.status, 9, 'the command exit code survives a state write failure');
});

test('state is written atomically: no temporary file is left beside it', () => {
  const box = sandbox();
  guard(box, ['--', script(box, 'op-ok5', 'exit 0')]);
  guard(box, ['--', script(box, 'op-fail6', 'exit 3')]);
  assert.deepEqual(fs.readdirSync(box.state), ['t.json']);
});

test('status: a read inside the window is verified (exit 0) and reports its age', () => {
  const box = sandbox();
  seed(box, 't', { failures: 0, openUntilMs: 0, lastSuccessAt: ago(60) });
  const out = status(box, ['--max-age-s', '3600', '--key', 't']);
  assert.equal(out.code, 0);
  assert.equal(out.json.keys[0].state, 'verified');
  assert.ok(Math.abs(out.json.keys[0].verifiedAgeS - 60) < 10);
});

test('status: a read older than the window is stale (exit 76), not verified, even though nothing ever failed', () => {
  const box = sandbox();
  seed(box, 't', { failures: 0, openUntilMs: 0, lastSuccessAt: ago(7200) });
  const out = status(box, ['--max-age-s', '3600', '--key', 't']);
  assert.equal(out.code, 76);
  assert.equal(out.json.keys[0].state, 'stale');
});

test('status: a key with no recorded read is never-verified (exit 76)', () => {
  const box = sandbox();
  const out = status(box, ['--max-age-s', '3600', '--key', 'missing']);
  assert.equal(out.code, 76);
  assert.equal(out.json.keys[0].state, 'never-verified');
  assert.equal(out.json.keys[0].verifiedAgeS, null);
  assert.equal(fs.existsSync(box.state), false, 'status is read-only: it must not create the state directory');
});

test('status: an open breaker and a failing credential are both exit 75, whatever the last success was', () => {
  const box = sandbox();
  seed(box, 'open', { failures: 3, openUntilMs: Date.now() + 120_000, lastSuccessAt: ago(30) });
  seed(box, 'failing', { failures: 1, openUntilMs: Date.now() - 1000, lastSuccessAt: ago(30) });
  const open = status(box, ['--max-age-s', '3600', '--key', 'open']);
  assert.equal(open.code, 75);
  assert.equal(open.json.keys[0].state, 'breaker-open');
  assert.ok(open.json.keys[0].retryInS > 100);
  const failing = status(box, ['--max-age-s', '3600', '--key', 'failing']);
  assert.equal(failing.code, 75);
  assert.equal(failing.json.keys[0].state, 'failing');
});

test('status: with no --key it reads every key and the worst one decides the exit code', () => {
  const box = sandbox();
  seed(box, 'b-stale', { failures: 0, openUntilMs: 0, lastSuccessAt: ago(9000) });
  seed(box, 'a-ok', { failures: 0, openUntilMs: 0, lastSuccessAt: ago(5) });
  fs.writeFileSync(path.join(box.state, 'a-ok.json.123.tmp'), '{}');
  const out = status(box, ['--max-age-s', '3600']);
  assert.equal(out.code, 76);
  assert.deepEqual(out.json.keys.map((k) => [k.key, k.state]), [['a-ok', 'verified'], ['b-stale', 'stale']]);
  seed(box, 'c-open', { failures: 1, openUntilMs: Date.now() + 60_000 });
  assert.equal(status(box, ['--max-age-s', '3600']).code, 75, 'a failing credential outranks a stale one');
});

test('status: no state at all is unverified, not healthy', () => {
  const box = sandbox();
  const out = status(box, ['--max-age-s', '3600']);
  assert.equal(out.code, 76);
  assert.deepEqual(out.json.keys, []);
});

test('status: --max-age-s is required, because a check with no expiry is the cached preflight this replaces', () => {
  const box = sandbox();
  const out = status(box, ['--key', 't']);
  assert.equal(out.code, 2);
  assert.match(out.stderr, /usage: op-guard status --max-age-s/u);
  assert.equal(out.stdout, '');
});

test('status: a damaged or hand-edited file cannot inject text into the report', () => {
  const box = sandbox();
  seed(box, 'edited', {
    failures: 1,
    openUntilMs: Date.now() + 60_000,
    lastFailure: { at: 'not a date', cause: 'x y; rm -rf /', auth: 'a\nb', network: { host: 'evil\nline', dns: 'ok' }, opProcessStates: ['S', 'rm -rf', 7] },
  });
  fs.writeFileSync(path.join(box.state, 'damaged.json'), '{ not json');
  const edited = status(box, ['--max-age-s', '60', '--key', 'edited']).json.keys[0];
  assert.equal(edited.lastFailure.at, null);
  assert.equal(edited.lastFailure.cause, null);
  assert.equal(edited.lastFailure.auth, null);
  assert.equal(edited.lastFailure.network.host, null);
  assert.equal(edited.lastFailure.network.dns, 'ok');
  assert.deepEqual(edited.lastFailure.opProcessStates, ['S']);
  assert.equal(status(box, ['--max-age-s', '60', '--key', 'damaged']).json.keys[0].state, 'never-verified');
});

test('after an idle gap status says stale, a guarded read proves the credential, and status then says verified', () => {
  const box = sandbox();
  seed(box, 't', { failures: 0, openUntilMs: 0, lastSuccessAt: ago(8 * 3600) });
  assert.equal(status(box, ['--max-age-s', '3600', '--key', 't']).code, 76);
  const read = guard(box, ['--', script(box, 'op-read', 'echo VALUE-NOT-EXPOSED >/dev/null; exit 0')]);
  assert.equal(read.status, 0);
  assert.equal(read.stdout, '', 'the verification read discards the value');
  assert.equal(status(box, ['--max-age-s', '3600', '--key', 't']).code, 0);
});

test('verdicts and exit codes follow one table', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  const state = (over) => ({ failures: 0, openUntilMs: 0, lastSuccessAt: null, lastFailure: null, ...over });
  const at = (seconds) => new Date(now - seconds * 1000).toISOString();
  const cases = [
    [state({ lastSuccessAt: at(10) }), 'verified'],
    [state({ lastSuccessAt: at(3600) }), 'verified'],
    [state({ lastSuccessAt: at(3601) }), 'stale'],
    [state({}), 'never-verified'],
    [state({ failures: 1, openUntilMs: now + 5000, lastSuccessAt: at(10) }), 'breaker-open'],
    [state({ failures: 1, openUntilMs: now - 5000, lastSuccessAt: at(10) }), 'failing'],
  ];
  for (const [input, expected] of cases) assert.equal(keyVerdict('k', input, 3600, now).state, expected);
  const verdicts = (...states) => states.map((s) => ({ state: s }));
  assert.equal(statusExitCode(verdicts('verified', 'verified')), 0);
  assert.equal(statusExitCode(verdicts('verified', 'stale')), 76);
  assert.equal(statusExitCode(verdicts('never-verified')), 76);
  assert.equal(statusExitCode(verdicts('stale', 'failing')), 75);
  assert.equal(statusExitCode(verdicts('breaker-open')), 75);
  assert.equal(statusExitCode([]), 76);
});

test('probe and status options parse, and bad ones are refused', () => {
  assert.deepEqual(parseArgs(['--', 'op']).options.probe, DEFAULT_PROBE);
  assert.equal(parseArgs(['--no-probe', '--', 'op']).options.probe, null);
  assert.deepEqual(parseArgs(['--probe-host', 'acme.1password.com:8443', '--', 'op']).options.probe, { host: 'acme.1password.com', port: 8443 });
  assert.match(parseArgs(['--probe-host', 'a b', '--', 'op']).error, /--probe-host/u);
  assert.match(parseArgs(['--probe-host', '--', 'op']).error, /--probe-host|unknown/u);
  assert.equal(parseProbeTarget('host'). port, 443);
  for (const bad of ['', 'host:0', 'host:70000', 'https://host', 'host:80:80', '-host', 'host name']) assert.equal(parseProbeTarget(bad), null, bad);
  assert.equal(parseStatusArgs(['--max-age-s', '0']).error?.includes('usage'), true);
  assert.deepEqual(parseStatusArgs(['--max-age-s', '90', '--key', 'a', '--key', 'b']).options.keys, ['a', 'b']);
});
