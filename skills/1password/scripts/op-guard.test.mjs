import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { descendantsOf, findMarkedProcesses, nextBackoffMs, parseArgs } from './op-guard.mjs';

const GUARD = path.join(path.dirname(new URL(import.meta.url).pathname), 'op-guard.mjs');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-guard-'));
  return { dir, state: path.join(dir, 'state'), marker: path.join(dir, 'ran') };
}

function guard(box, args, { timeoutMs = 20000 } = {}) {
  return spawnSync(process.execPath, [GUARD, '--state-dir', box.state, '--key', 't', ...args], { encoding: 'utf8', timeout: timeoutMs });
}

function script(box, name, body) {
  const file = path.join(box.dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

test('a successful command passes its output through and leaves no breaker', () => {
  const box = sandbox();
  const op = script(box, 'op-ok', 'echo VALUE-THAT-IS-NOT-LOGGED; exit 0');
  const out = guard(box, ['--', op]);
  assert.equal(out.status, 0);
  assert.equal(out.stdout.trim(), 'VALUE-THAT-IS-NOT-LOGGED');
  assert.equal(fs.existsSync(path.join(box.state, 't.json')), false);
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
