import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifyProbe, nextSteps, parseArgs, parseDaemons, readBreakers } from './op-doctor.mjs';

const DOCTOR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'op-doctor.mjs');
const TOKEN_VALUE = 'ops_TOKEN-VALUE-MUST-NEVER-APPEAR';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-doctor-'));
  return { dir, state: path.join(dir, 'state'), marker: path.join(dir, 'read-ran') };
}

function script(box, name, body) {
  const file = path.join(box.dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

/** Runs the CLI with a controlled environment; the token is only set when a test asks for it. */
function doctor(box, op, args = [], { token = false, timeoutMs = 30000 } = {}) {
  const env = { PATH: process.env.PATH, HOME: box.dir, ...(token ? { OP_SERVICE_ACCOUNT_TOKEN: TOKEN_VALUE } : {}) };
  const out = spawnSync(process.execPath, [DOCTOR, '--op-bin', op, '--state-dir', box.state, '--json', ...args], { encoding: 'utf8', timeout: timeoutMs, env });
  let report = null;
  try { report = JSON.parse(out.stdout); } catch { /* usage error or crash */ }
  return { ...out, report };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('a provider that answers is reported ok, exits 0, and the token value never appears', () => {
  const box = sandbox();
  const op = script(box, 'op-ok', 'exit 0');
  const out = doctor(box, op, [], { token: true });
  assert.equal(out.status, 0);
  assert.equal(out.report.ok, true);
  assert.equal(out.report.code, 'CREDENTIAL_PROVIDER_OK');
  assert.equal(out.report.environment.serviceAccountToken, 'present');
  assert.equal(out.report.probes.whoami.status, 'OK');
  assert.equal(out.report.probes.ref, null);
  assert.equal(`${out.stdout}${out.stderr}`.includes(TOKEN_VALUE), false);
});

test('a hang is a bounded CREDENTIAL_PROVIDER_TIMEOUT, kills its process group, and says the token is missing', () => {
  const box = sandbox();
  const pidFile = path.join(box.dir, 'child.pid');
  const op = script(box, 'op-hang', `sleep 300 & echo $! > ${pidFile}; wait`);
  const started = Date.now();
  const out = doctor(box, op, ['--timeout-s', '1']);
  assert.ok(Date.now() - started < 20000, 'the probe is bounded by --timeout-s');
  assert.equal(out.status, 1);
  assert.equal(out.report.ok, false);
  assert.equal(out.report.code, 'CREDENTIAL_PROVIDER_TIMEOUT');
  assert.equal(out.report.probes.whoami.status, 'TIMEOUT');
  assert.equal(out.report.environment.serviceAccountToken, 'absent');
  assert.match(out.report.nextSteps.join('\n'), /No OP_SERVICE_ACCOUNT_TOKEN is set in this process/u);
  assert.equal(alive(Number(fs.readFileSync(pidFile, 'utf8'))), false, 'the hung probe must not leave a process behind');
});

test('a hang with a token set points at the provider connection, not the desktop app', () => {
  const box = sandbox();
  const op = script(box, 'op-hang2', 'sleep 300 & wait');
  const out = doctor(box, op, ['--timeout-s', '1'], { token: true });
  assert.equal(out.report.code, 'CREDENTIAL_PROVIDER_TIMEOUT');
  assert.equal(out.report.environment.serviceAccountToken, 'present');
  const steps = out.report.nextSteps.join('\n');
  assert.match(steps, /Check outbound HTTPS/u);
  assert.doesNotMatch(steps, /No OP_SERVICE_ACCOUNT_TOKEN/u);
  assert.equal(`${out.stdout}${out.stderr}`.includes(TOKEN_VALUE), false);
});

test('op stderr is classified, never echoed', () => {
  const box = sandbox();
  const op = script(box, 'op-auth', 'echo "[ERROR] SECRET-IN-STDERR you are not signed in" >&2; exit 1');
  const out = doctor(box, op, [], { token: true });
  assert.equal(out.status, 1);
  assert.equal(out.report.code, 'CREDENTIAL_PROVIDER_AUTH');
  assert.equal(out.report.probes.whoami.exitCode, 1);
  assert.equal(`${out.stdout}${out.stderr}`.includes('SECRET-IN-STDERR'), false);
  const text = spawnSync(process.execPath, [DOCTOR, '--op-bin', op, '--state-dir', box.state], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: box.dir } });
  assert.equal(`${text.stdout}${text.stderr}`.includes('SECRET-IN-STDERR'), false);
  assert.match(text.stdout, /CREDENTIAL_PROVIDER_AUTH/u);
});

test('an op that cannot be started is UNAVAILABLE and says how to pin it', () => {
  const box = sandbox();
  const out = doctor(box, path.join(box.dir, 'no-such-op'));
  assert.equal(out.status, 1);
  assert.equal(out.report.code, 'CREDENTIAL_PROVIDER_UNAVAILABLE');
  assert.match(out.report.nextSteps.join('\n'), /could not be started/u);
});

test('--ref resolves the reference through op, reports only that it resolved, and discards the value', () => {
  const box = sandbox();
  const op = script(box, 'op-read', 'if [ "$1" = read ]; then echo SECRET-ABC123; fi; exit 0');
  const out = doctor(box, op, ['--ref', 'op://Agent/Katy2/credential']);
  assert.equal(out.status, 0);
  assert.equal(out.report.probes.ref.status, 'OK');
  assert.equal(out.report.probes.ref.reference, 'op://Agent/Katy2/credential');
  assert.equal(`${out.stdout}${out.stderr}`.includes('SECRET-ABC123'), false);
  const text = spawnSync(process.execPath, [DOCTOR, '--op-bin', op, '--state-dir', box.state, '--ref', 'op://Agent/Katy2/credential'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: box.dir } });
  assert.equal(`${text.stdout}${text.stderr}`.includes('SECRET-ABC123'), false);
});

test('a reference that is not found fails the run with its own class', () => {
  const box = sandbox();
  const op = script(box, 'op-missing', 'if [ "$1" = read ]; then echo "[ERROR] \\"Katy2\\" isn\'t an item in the \\"Agent\\" vault" >&2; exit 1; fi; exit 0');
  const out = doctor(box, op, ['--ref', 'op://Agent/Katy2/credential']);
  assert.equal(out.status, 1);
  assert.equal(out.report.probes.whoami.status, 'OK');
  assert.equal(out.report.probes.ref.status, 'NOT_FOUND');
  assert.equal(out.report.code, 'CREDENTIAL_PROVIDER_NOT_FOUND');
});

test('a failing provider skips the --ref read instead of repeating the hang', () => {
  const box = sandbox();
  const op = script(box, 'op-fail-first', `if [ "$1" = read ]; then touch ${box.marker}; fi; exit 1`);
  const out = doctor(box, op, ['--ref', 'op://Agent/Katy2/credential']);
  assert.equal(out.status, 1);
  assert.equal(out.report.probes.ref.status, 'SKIPPED');
  assert.equal(fs.existsSync(box.marker), false, 'op read must not run when whoami already failed');
});

test('breakers are listed read-only and a failing probe leaves a job breaker exactly as it was', () => {
  const box = sandbox();
  const op = script(box, 'op-fails', 'exit 1');
  fs.mkdirSync(box.state, { recursive: true });
  const file = path.join(box.state, 'lead-intake.json');
  const before = JSON.stringify({ failures: 10, openUntilMs: Date.now() + 600_000, lastFailureAt: '2026-10-07T00:00:00.000Z', timedOut: true });
  fs.writeFileSync(file, before);
  const out = doctor(box, op);
  assert.equal(out.report.breakers.length, 1);
  assert.equal(out.report.breakers[0].key, 'lead-intake');
  assert.equal(out.report.breakers[0].open, true);
  assert.equal(out.report.breakers[0].failures, 10);
  assert.equal(out.report.breakers[0].timedOut, true);
  assert.match(out.report.nextSteps.join('\n'), /Job breaker `lead-intake` is open until/u);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the doctor must not edit breaker state');
  assert.deepEqual(fs.readdirSync(box.state), ['lead-intake.json'], 'the probe must not write into the job state dir');
});

test('closed, empty and malformed breaker files are not reported as open', () => {
  const box = sandbox();
  fs.mkdirSync(box.state, { recursive: true });
  fs.writeFileSync(path.join(box.state, 'recovered.json'), JSON.stringify({ failures: 0, openUntilMs: 0, recoveredAt: 'x' }));
  fs.writeFileSync(path.join(box.state, 'junk.json'), 'not json');
  fs.writeFileSync(path.join(box.state, 'expired.json'), JSON.stringify({ failures: 2, openUntilMs: Date.now() - 1000 }));
  fs.writeFileSync(path.join(box.state, 'notes.txt'), 'ignored');
  const breakers = readBreakers(box.state);
  assert.deepEqual(breakers.map((b) => [b.key, b.open, b.failures]), [['expired', false, 2]]);
  assert.deepEqual(readBreakers(path.join(box.dir, 'missing')), []);
});

test('orphaned op daemons are counted by command and parent, not by name fragments', () => {
  const ps = [
    '  901     1 /opt/homebrew/bin/op daemon --background',
    '  902   901 /opt/homebrew/bin/op daemon --background',
    '  903     1 op daemon',
    '  904     1 /usr/bin/snoop daemon --verbose',
    '  905     1 /opt/homebrew/bin/op read op://Agent/x/y',
  ].join('\n');
  assert.deepEqual(parseDaemons(ps), { total: 3, orphaned: 2, pids: [901, 902, 903] });
  assert.deepEqual(parseDaemons(''), { total: 0, orphaned: 0, pids: [] });
});

test('classification keys off the guard exit codes first, then op error text', () => {
  const cases = [
    [{ exitCode: 0 }, 'OK'],
    [{ exitCode: 124 }, 'TIMEOUT'],
    [{ exitCode: null, signal: 'SIGTERM' }, 'TIMEOUT'],
    [{ exitCode: 127 }, 'UNAVAILABLE'],
    [{ exitCode: 143 }, 'CANCELLED'],
    [{ exitCode: 1, stderr: '[ERROR] (401) Unauthorized' }, 'AUTH'],
    [{ exitCode: 1, stderr: 'You are not currently signed in' }, 'AUTH'],
    [{ exitCode: 1, stderr: 'dial tcp: lookup my.1password.com: no such host' }, 'NETWORK'],
    [{ exitCode: 1, stderr: "\"x\" isn't an item in the \"y\" vault" }, 'NOT_FOUND'],
    [{ exitCode: 1, stderr: 'could not connect to the 1Password app' }, 'UNAVAILABLE'],
    [{ exitCode: 1, stderr: 'something new' }, 'UNKNOWN'],
    [{ exitCode: 9 }, 'UNKNOWN'],
  ];
  for (const [input, expected] of cases) assert.equal(classifyProbe(input), expected, JSON.stringify(input));
});

test('next steps never suggest bypassing the job or resetting its state', () => {
  const ok = { status: 'OK', exitCode: 0, ms: 5 };
  const steps = nextSteps({ tokenPresent: true, whoami: ok, ref: null, breakers: [], daemons: { total: 0, orphaned: 0, pids: [] }, timeoutS: 15 });
  assert.equal(steps.length, 1);
  assert.match(steps[0], /Re-enable the job through its own supported path/u);
  const all = nextSteps({ tokenPresent: false, whoami: { status: 'TIMEOUT', exitCode: 124, ms: 15000 }, ref: null,
    breakers: [{ key: 'k', open: true, openUntil: '2026-10-07T00:00:00.000Z', failures: 3 }], daemons: { total: 2, orphaned: 2, pids: [1, 2] }, timeoutS: 15 }).join('\n');
  assert.doesNotMatch(all, /rm |delete|reset/iu);
});

test('usage errors name the flag, never the value, so a pasted secret is not echoed', () => {
  assert.equal(parseArgs(['--ref', 'a-raw-secret-value']).error.includes('a-raw-secret-value'), false);
  assert.match(parseArgs(['--ref', 'a-raw-secret-value']).error, /--ref .*op:\/\/vault\/item\/field/u);
  assert.match(parseArgs(['--bogus']).error, /unknown/u);
  assert.match(parseArgs(['--timeout-s', '0']).error, /--timeout-s/u);
  assert.equal(parseArgs(['--timeout-s', '7', '--json', '--ref', 'op://V/I/f'], {}).options.timeoutS, 7);
  assert.equal(parseArgs([], { FORGE_OP_BIN: '/Users/benchharness/homebrew/bin/op' }).options.opBin, '/Users/benchharness/homebrew/bin/op');
  assert.equal(parseArgs([], {}).options.opBin, 'op');
  const box = sandbox();
  const out = spawnSync(process.execPath, [DOCTOR, '--ref', 'a-raw-secret-value'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: box.dir } });
  assert.equal(out.status, 2);
  assert.equal(`${out.stdout}${out.stderr}`.includes('a-raw-secret-value'), false);
});

test('the process listing is reported, or reported as unavailable, never thrown', () => {
  const box = sandbox();
  const op = script(box, 'op-ok-ps', 'exit 0');
  const { report } = doctor(box, op);
  assert.ok(report.daemons === null || (Number.isInteger(report.daemons.total) && Number.isInteger(report.daemons.orphaned)));
});
