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
- First `op` call in a session triggers a **biometric prompt** (Touch ID / password) in
  the desktop app — this is expected. Tell the user to approve it; do not retry in a loop
  while the prompt is pending.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `op: command not found` | `brew install --cask 1password-cli` (a cask, not a formula). HaaS boxes install it in `/Users/benchharness/homebrew/bin/op` and pin `FORGE_OP_BIN` via `scripts/harness-walled-bootstrap.sh`; system Homebrew commonly uses `/opt/homebrew/bin/op`. |
| `op` hangs, then times out | A biometric prompt is waiting in the desktop app — have the user approve it. |
| "could not connect to the 1Password app" / auth errors | Desktop app not running, or Settings → Developer → "Integrate with 1Password CLI" is off. Start the app and enable the toggle. |
| Item/vault not found | `op vault list` then `op item list --vault '<vault>'` to confirm exact names; names with spaces need quotes. |
| Works in one terminal, not another | The CLI binds to the account the desktop app is signed into; check `op whoami`. |

## Hard rules

- Never persist a secret to disk, git, chat, or a log — including "temporarily".
- Never widen scope: if the designated vault lacks the item, report the gap; do not go
  hunting through other vaults.
- Never store a new secret yourself without being asked; creation/rotation is a human
  (or explicitly delegated) action.
