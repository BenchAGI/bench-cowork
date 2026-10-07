#!/usr/bin/env node
/**
 * op-doctor — a read-only answer to "why can't this seat read its credential?", for an operator or an
 * unattended job's health report.
 *
 *   op-doctor [--ref 'op://Vault/Item/field'] [--timeout-s 15] [--op-bin PATH] [--state-dir DIR] [--json]
 *
 * Why it exists (BenchAGI/BenchAGI_Mono_Repo#8810): a seat's scheduled lead-intake job's `op read`
 * timed out after 40 s on every run until the automation disabled itself, and the seat had no supported
 * way to tell a missing service-account token from an unreachable provider, an open breaker or a pile
 * of orphaned daemons. `op-guard` stops the damage; this says what is wrong.
 *
 * What it does, all read-only:
 *   1. Reports whether OP_SERVICE_ACCOUNT_TOKEN is set in THIS process's environment (never its value).
 *      Run it the way the job runs: an interactive shell can differ from a gateway lane or a launchd job.
 *   2. Probes the provider with `op whoami` through `op-guard`, so a hang is killed with its whole process
 *      group and anything it left behind. The probe uses a throwaway state dir: it never opens, closes or
 *      reads a job's breaker.
 *   3. With --ref, reads that one reference through the same guard and DISCARDS the value. Only
 *      "resolved" or the failure class is reported.
 *   4. Lists the job breakers in the guard's state dir (read only; nothing is edited or reset) and counts
 *      `op daemon` processes, flagging orphans (parent 1).
 *
 * It never reads, prints or stores a secret. The probes' stdout is discarded and their stderr is only
 * classified, never echoed. It changes nothing: no breaker, no config, no process it did not start.
 *
 * Exit codes: 0 the provider answered (and the --ref resolved, if given); 1 a probe failed; 2 usage error.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'op-guard.mjs');
const REF_PATTERN = /^op:\/\/[^\s]+$/u;
const STDERR_CAP = 64 * 1024;
const MAX_BREAKERS = 50;

export function parseArgs(argv, env = process.env) {
  const options = {
    ref: null,
    timeoutS: 15,
    opBin: env.FORGE_OP_BIN || 'op',
    stateDir: path.join(os.homedir(), '.cache', 'bench-op-guard'),
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--json') {
      options.json = true;
      continue;
    }
    const value = argv[i + 1];
    const number = Number(value);
    if (flag === '--ref' && value && REF_PATTERN.test(value)) options.ref = value;
    else if (flag === '--timeout-s' && Number.isFinite(number) && number > 0) options.timeoutS = number;
    else if (flag === '--op-bin' && value) options.opBin = value;
    else if (flag === '--state-dir' && value) options.stateDir = value;
    else return { error: `unknown or invalid option: ${flag}${flag === '--ref' ? ' (expected op://vault/item/field)' : ''}` };
    i += 1;
  }
  return { options };
}

/**
 * Turn a finished probe into one status. Exit codes are the guard's own (0 ok, 124 timed out and killed,
 * 127 could not start, 129/130/143 cancelled); anything else is `op`'s, classified from its stderr text,
 * which is matched and never echoed. The text patterns are best-effort: an unrecognised failure is UNKNOWN.
 */
export function classifyProbe({ exitCode, signal = null, stderr = '' }) {
  if (signal) return 'TIMEOUT';
  if (exitCode === 0) return 'OK';
  if (exitCode === 124) return 'TIMEOUT';
  if (exitCode === 127) return 'UNAVAILABLE';
  if ([129, 130, 143].includes(exitCode)) return 'CANCELLED';
  const text = String(stderr).toLowerCase();
  if (/not (currently )?signed in|authenticat|unauthori[sz]ed|forbidden|\((401|403)\)|invalid.{0,40}token|session.{0,20}expired/u.test(text)) return 'AUTH';
  if (/isn't (a|an) (vault|item)|could not be found|no item|not found/u.test(text)) return 'NOT_FOUND';
  if (/1password app|desktop app|no accounts? (configured|found)/u.test(text)) return 'UNAVAILABLE';
  if (/no such host|dial tcp|i\/o timeout|network is unreachable|connection (refused|reset)|tls|certificate|name resolution/u.test(text)) return 'NETWORK';
  return 'UNKNOWN';
}

/** Breakers the guard recorded, as facts only: key, count, window, and why. Read-only; unreadable files are skipped. */
export function readBreakers(stateDir, now = Date.now()) {
  let names;
  try {
    names = fs.readdirSync(stateDir).filter((name) => name.endsWith('.json')).sort().slice(0, MAX_BREAKERS);
  } catch {
    return [];
  }
  const breakers = [];
  for (const name of names) {
    try {
      const state = JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8'));
      const failures = Number(state.failures) || 0;
      const openUntilMs = Number(state.openUntilMs) || 0;
      if (failures === 0 && openUntilMs === 0) continue;
      breakers.push({
        key: name.slice(0, -'.json'.length),
        failures,
        open: openUntilMs > now,
        openUntil: openUntilMs > 0 ? new Date(openUntilMs).toISOString() : null,
        lastFailureAt: typeof state.lastFailureAt === 'string' ? state.lastFailureAt : null,
        timedOut: state.timedOut === true,
        cancelledBy: typeof state.cancelledBy === 'string' ? state.cancelledBy : null,
      });
    } catch { /* not a breaker file */ }
  }
  return breakers;
}

/** `op daemon` processes in a `ps -o pid=,ppid=,command=` listing; orphans are the ones whose parent is init. */
export function parseDaemons(psText) {
  const daemons = [];
  for (const line of psText.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/u);
    if (match && /(?:^|\/)op\s+daemon(?:\s|$)/u.test(match[3])) daemons.push({ pid: Number(match[1]), orphaned: Number(match[2]) === 1 });
  }
  return { total: daemons.length, orphaned: daemons.filter((d) => d.orphaned).length, pids: daemons.map((d) => d.pid) };
}

function listDaemons() {
  const result = spawnSync('ps', ['-axwwo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? parseDaemons(result.stdout ?? '') : null;
}

/** One `op` call through op-guard with a throwaway breaker: stdout discarded, stderr kept only to classify. */
function probe(opBin, opArgs, timeoutS) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-doctor-'));
  const started = Date.now();
  return new Promise((resolve) => {
    let stderr = '';
    const child = spawn(
      process.execPath,
      [GUARD, '--state-dir', stateDir, '--key', 'doctor', '--timeout-s', String(timeoutS), '--', opBin, ...opArgs],
      { stdio: ['ignore', 'ignore', 'pipe'], timeout: (timeoutS + 20) * 1000 },
    );
    child.stderr.on('data', (chunk) => {
      if (stderr.length < STDERR_CAP) stderr += chunk;
    });
    child.on('error', () => resolve({ exitCode: 127, signal: null, stderr: '' }));
    child.on('close', (exitCode, signal) => resolve({ exitCode, signal, stderr }));
  }).then((result) => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    const status = classifyProbe(result);
    return { status, exitCode: result.signal ? null : result.exitCode, ms: Date.now() - started };
  });
}

export function nextSteps({ tokenPresent, whoami, ref, breakers, daemons, timeoutS }) {
  const steps = [];
  const failed = [whoami, ref].find((p) => p && p.status !== 'OK');
  const status = failed?.status ?? 'OK';
  if (status === 'TIMEOUT' && !tokenPresent) {
    steps.push(
      'No OP_SERVICE_ACCOUNT_TOKEN is set in this process, so `op` falls back to the 1Password desktop app, which an unattended job cannot ' +
        'answer (the 2026-10-01 lead-intake hang described in the 1password skill). Supply the vault-limited service-account token through the supervisor\'s secret channel, ' +
        'then run op-doctor again the way the job runs.',
    );
  } else if (status === 'TIMEOUT') {
    steps.push(
      `A service-account token is set, so the desktop app is not the likely cause, yet \`op\` did not answer within ${timeoutS}s. ` +
        'Check outbound HTTPS from this seat to the account\'s 1Password domain (for example my.1password.com) and whether the token was revoked.',
    );
  } else if (status === 'AUTH') {
    steps.push(
      tokenPresent
        ? 'The provider refused the service-account token (revoked, expired, or not granted this vault). Re-issuing it is a human action; do not paste a replacement into an agent session.'
        : 'No service-account token is set and there is no signed-in session for `op`. Supply the token through the supervisor\'s secret channel.',
    );
  } else if (status === 'NETWORK') {
    steps.push('`op` could not reach 1Password (DNS, TLS or connection failure). Fix egress from this seat, then run op-doctor again.');
  } else if (status === 'NOT_FOUND') {
    steps.push('The provider answered but the reference was not found. Confirm the exact names with `op vault list` and `op item list --vault \'<vault>\'`; do not search other vaults.');
  } else if (status === 'UNAVAILABLE') {
    steps.push(
      whoami.exitCode === 127 && whoami.status === 'UNAVAILABLE'
        ? '`op` could not be started. Install it, or pin its path with --op-bin / FORGE_OP_BIN.'
        : '`op` could not reach the 1Password desktop app. An unattended job should use a service-account token instead.',
    );
  } else if (status === 'CANCELLED') {
    steps.push('The probe was cancelled before it finished; run op-doctor again.');
  } else if (status === 'UNKNOWN') {
    steps.push('`op` failed in a way op-doctor does not recognise. Run `op whoami` yourself, in the same environment as the job, and read its error.');
  }
  if (daemons && daemons.orphaned > 0) {
    steps.push(
      `${daemons.orphaned} \`op daemon\` process(es) are orphaned (parent 1). op-guard clears only what it started itself; ` +
        'inspect with `ps -axo pid,ppid,etime,command | grep \'op daemon\'` before ending any.',
    );
  }
  for (const breaker of breakers.filter((b) => b.open)) {
    steps.push(
      `Job breaker \`${breaker.key}\` is open until ${breaker.openUntil} after ${breaker.failures} failure(s). The job will not call \`op\` before then, ` +
        'and a successful guarded read closes it. op-doctor never edits breaker state.',
    );
  }
  if (status === 'OK') {
    steps.push('The provider answered. Re-enable the job through its own supported path; op-doctor changed nothing.');
  }
  return steps;
}

export async function diagnose(options, env = process.env) {
  const tokenPresent = typeof env.OP_SERVICE_ACCOUNT_TOKEN === 'string' && env.OP_SERVICE_ACCOUNT_TOKEN.trim() !== '';
  const whoami = await probe(options.opBin, ['whoami'], options.timeoutS);
  let ref = null;
  if (options.ref) {
    ref = whoami.status === 'OK'
      ? await probe(options.opBin, ['read', options.ref], options.timeoutS)
      : { status: 'SKIPPED', exitCode: null, ms: 0 };
  }
  const breakers = readBreakers(options.stateDir);
  const daemons = listDaemons();
  const failed = [whoami, ref].find((p) => p && p.status !== 'OK' && p.status !== 'SKIPPED');
  const code = failed ? `CREDENTIAL_PROVIDER_${failed.status}` : 'CREDENTIAL_PROVIDER_OK';
  return {
    ok: !failed,
    code,
    environment: { opBin: options.opBin, serviceAccountToken: tokenPresent ? 'present' : 'absent' },
    probes: { whoami, ref: ref ? { reference: options.ref, ...ref } : null },
    breakers,
    daemons,
    nextSteps: nextSteps({ tokenPresent, whoami, ref, breakers, daemons, timeoutS: options.timeoutS }),
  };
}

export function formatReport(report) {
  const probeLine = (p) => (p.status === 'SKIPPED' ? 'skipped (the provider did not answer)' : `${p.status}${p.exitCode === null ? '' : ` (exit ${p.exitCode})`} in ${p.ms} ms`);
  const row = (label, value) => `${`${label}:`.padEnd(28)}${value}`;
  const lines = [
    `op-doctor: ${report.ok ? 'the credential provider answered' : 'the credential provider is NOT usable'} (${report.code})`,
    '',
    row('op binary', report.environment.opBin),
    row('service-account token', `${report.environment.serviceAccountToken} in this process's environment`),
    row('op whoami', probeLine(report.probes.whoami)),
  ];
  if (report.probes.ref) lines.push(row('op read (value discarded)', `${probeLine(report.probes.ref)} — ${report.probes.ref.reference}`));
  lines.push(row('op daemons', report.daemons ? `${report.daemons.total} running, ${report.daemons.orphaned} orphaned` : 'could not list processes'));
  if (report.breakers.length === 0) lines.push(row('job breakers', 'none recorded'));
  for (const b of report.breakers) {
    lines.push(
      row(
        `job breaker ${b.key}`,
        `${b.open ? `OPEN until ${b.openUntil}` : 'closed'}, ${b.failures} failure(s)` +
          `${b.lastFailureAt ? `, last ${b.lastFailureAt}` : ''}${b.timedOut ? ', last was a timeout' : ''}${b.cancelledBy ? `, cancelled by ${b.cancelledBy}` : ''}`,
      ),
    );
  }
  if (report.nextSteps.length > 0) lines.push('', 'next steps:', ...report.nextSteps.map((step) => `  - ${step}`));
  return `${lines.join('\n')}\n`;
}

export async function run(argv, env = process.env) {
  const parsed = parseArgs(argv, env);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\nusage: op-doctor [--ref op://vault/item/field] [--timeout-s N] [--op-bin PATH] [--state-dir DIR] [--json]\n`);
    return 2;
  }
  const report = await diagnose(parsed.options, env);
  process.stdout.write(parsed.options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
  return report.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
