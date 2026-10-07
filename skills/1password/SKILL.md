---
name: 1password
description: Read secrets from 1Password with the `op` CLI under the Bench vault doctrine — customer "bench agent vault" pattern, one-time tokens instead of raw credentials, `op read op://vault/item/field`, never printing secret values. Trigger whenever a task needs a credential, API key, token, or password ("grab the key from 1Password", "read the vault", "op read", any `op://` reference), when a script fails because `op` is missing or unauthenticated, or before wiring a secret into a command or config. Also covers troubleshooting — op not installed, CLI integration disabled, biometric prompt flow.
---

# 1Password (op) — Bench vault doctrine

How Bench agents read secrets. The 1Password CLI (`op`) is the ONLY sanctioned path from
a vault to a running command — secrets never live in files, env exports pasted into chat,
shell history, or logs.

## The doctrine

1. **Customer "bench agent vault" pattern.** Each HaaS customer gets a dedicated 1Password
   vault for their bench agent (e.g. `Dolan Bench Agent`). Agents read ONLY from their
   designated vault — never from the owner's personal or shared vaults, even when access
   would technically resolve.
2. **One-time tokens, not raw credentials.** Where a service supports it, the vault holds
   short-lived or single-use tokens minted for the agent, not the human's long-lived
   password. If a task seems to need a raw credential, stop and ask for a scoped token to
   be provisioned instead.
3. **NEVER print, log, or echo a secret value.** No `echo $SECRET`, no pasting into chat,
   no writing to files, no `--format json` dumps of items with secret fields left in
   scrollback. Pipe values directly into the consumer:

   ```bash
   # good — the value never touches scrollback or history
   op read 'op://Dolan Bench Agent/Stripe/restricted_key' | some-cli login --key-stdin
   MY_TOKEN="$(op read 'op://Agents/Service X/token')" some-command   # env for one process only

   # bad — leaks to scrollback / logs / history
   echo "$(op read 'op://Agents/Service X/token')"
   ```

## Core usage

```bash
op --version                                   # is op installed + which version
op vault list                                  # which vaults this account can see
op item list --vault '<vault>'                 # what's in the agent vault
op item get '<item>' --vault '<vault>' --fields label=username   # non-secret fields
op read 'op://<vault>/<item>/<field>'          # THE read primitive — one field, stdout
```

- `op read op://vault/item/field` is the workhorse: exact vault, exact item, exact field.
  Quote the URI — vault and item names often contain spaces.
- `op item get --fields` is for inspecting item *shape* (labels, non-secret metadata).
  Do not use it to display secret fields.
- Reads work with process substitution too, keeping secrets out of argv:
  `--password-file <(op read 'op://Shared/Bench Harness host/password')`.

## Prerequisites

- **Headless harness:** inject a vault-limited 1Password service-account token as
  `OP_SERVICE_ACCOUNT_TOKEN` through the supervisor's secret channel; never commit,
  print, or persist the token, and do not expect desktop biometric integration.
- **Desktop-app integration must be ON**: 1Password app → Settings → Developer →
  enable **"Integrate with 1Password CLI"**. Without it, every `op` call fails to
  authenticate no matter what the CLI does.
- First `op` call in an **interactive** session triggers a **biometric prompt** (Touch ID /
  password) in the desktop app — this is expected. Tell the user to approve it; do not retry
  in a loop while the prompt is pending.

## Unattended and scheduled jobs (cron, gateway lanes, launchd)

Nobody is there to answer a prompt, so a scheduled job must never depend on one, and must
never call `op` in a bare loop. Remedy's lead-intake job (2026-10-01) called `op read` every
2 minutes; when `op` hung (blocked opening the 1Password desktop app's settings file), its
15 s timeout killed the client but not the `op daemon --background` it had spawned. Forty
orphans piled up in 16 minutes and every run was a fresh hang with no pause.

1. **Wrap every `op` call in the guard.** It runs the command in its own process group,
   kills the whole group on timeout (SIGTERM, then SIGKILL, and it waits until the group is
   gone), also kills any process it started that escaped into its own session (identified by a
   per-run marker, never by name or age, so other jobs' `op daemon`s are untouched), stops
   cleanly when the scheduler sends it SIGTERM/SIGINT/SIGHUP, and opens a breaker so a
   failing job backs off (30 s, 60 s, 120 s ... capped at 30 min) instead of retrying:

   ```bash
   node scripts/op-guard.mjs --timeout-s 15 --key lead-intake -- op read 'op://Agent/<item>/credential'
   ```

   Exit codes: `124` timed out and was killed; `75` breaker open, `op` was not called;
   `129`/`130`/`143` the guard was cancelled by SIGHUP/SIGINT/SIGTERM (counted as a failure).
   Treat both as "credential unavailable": skip the run, alert once, do not loop.
2. **Read once per run, not once per item.** Resolve what the run needs up front (or hold it
   in the process's memory for the life of a long-running worker). Do not read the same
   secret every cycle.
3. **Use a service-account token for headless work** (`OP_SERVICE_ACCOUNT_TOKEN`, supplied
   by the supervisor's secret channel). The desktop-app integration is for people at a
   keyboard; a scheduled job that depends on it will eventually hit a prompt nobody sees.
4. **Alert on the breaker, once.** A job that cannot read its credential must say so
   (health report, owner message) rather than fail silently every cycle.
5. **Diagnose with `op-doctor` before re-enabling a job.** When a job's credential read keeps
   timing out (a seat's lead-intake automation, #8810: `op read` timed out at 40 s until the automation
   auto-disabled), run the doctor *the way the job runs* — same user, same environment, the
   gateway lane or launchd context, not a login shell — because whether
   `OP_SERVICE_ACCOUNT_TOKEN` is set there is the first thing it checks:

   ```bash
   node scripts/op-doctor.mjs                                   # provider probe + breakers + orphaned daemons
   node scripts/op-doctor.mjs --ref 'op://Agent/<item>/credential' --json   # also prove one reference resolves
   ```

   It is read-only. It probes with `op whoami` through `op-guard` (a hang is killed with its
   whole process group), with a throwaway breaker, so it never opens, closes or edits a job's
   breaker. `--ref` reads that one reference and **discards the value**: only "resolved" or the
   failure class is reported. It reports whether the token is set, never its value, and it
   classifies `op`'s error text without echoing it. Exit `0` the provider answered, `1` a probe
   failed, `2` usage. The result code is `CREDENTIAL_PROVIDER_` plus `OK`, `TIMEOUT`, `AUTH`,
   `NETWORK`, `NOT_FOUND`, `UNAVAILABLE`, `CANCELLED` or `UNKNOWN`, with next steps for what it
   found. Only after it is `OK` should the job be re-enabled, through the job's own supported
   path; the doctor changes nothing, and it never suggests resetting a job's cursor or retry
   data. Wiring it into `customer-harness-health` is a separate piece of work.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `op: command not found` | `brew install --cask 1password-cli` (a cask, not a formula). HaaS boxes install it in `/Users/benchharness/homebrew/bin/op` and pin `FORGE_OP_BIN` via `scripts/harness-walled-bootstrap.sh`; system Homebrew commonly uses `/opt/homebrew/bin/op`. |
| `op` hangs, then times out | Interactive: a biometric prompt is waiting in the desktop app — have the user approve it. Unattended: `op` may be blocked opening the desktop app's settings file (macOS privacy prompt or a stuck app); see "Unattended and scheduled jobs" — use `op-guard`, and look at the Mac's screen for a pending "access data from other apps" dialog before clicking anything. |
| A scheduled job's `op read` times out every run (`CREDENTIAL_PROVIDER_TIMEOUT`) | Run `node scripts/op-doctor.mjs` in the job's own environment. No `OP_SERVICE_ACCOUNT_TOKEN` there means `op` is falling back to the desktop app; a token that is set but still times out points at egress to 1Password or a revoked token. See "Unattended and scheduled jobs" item 5. |
| Many `op daemon --background` processes with parent 1 | Orphans from killed `op` clients. `ps -axo pid,ppid,etime,command \| grep 'op daemon'`; `op-guard` clears what it started itself, not other jobs' daemons. A stale `~/.config/op/op-daemon.sock` with no live owner is a symptom, not a cause. |
| "could not connect to the 1Password app" / auth errors | Desktop app not running, or Settings → Developer → "Integrate with 1Password CLI" is off. Start the app and enable the toggle. |
| Item/vault not found | `op vault list` then `op item list --vault '<vault>'` to confirm exact names; names with spaces need quotes. |
| Works in one terminal, not another | The CLI binds to the account the desktop app is signed into; check `op whoami`. |

## Hard rules

- Never persist a secret to disk, git, chat, or a log — including "temporarily".
- Never widen scope: if the designated vault lacks the item, report the gap; do not go
  hunting through other vaults.
- Never store a new secret yourself without being asked; creation/rotation is a human
  (or explicitly delegated) action.
