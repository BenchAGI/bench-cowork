---
name: bench-login
description: Authenticate the current Claude Code session with BenchAGI so agents know whose canon, inbox, and instance to operate against. Writes the issued token to ~/.claude/config/bench-cowork.json. Required before any @agent or /wiki-capture command.
---

Authenticate `$ARGUMENTS` (optional email) with BenchAGI via Path A (simple paste flow).

## Workflow

1. **Parse the argument.** If `$ARGUMENTS` is empty, print the current auth state from `~/.claude/config/bench-cowork.json` (if present) and exit. If an email is provided, continue.

2. **Tell the user to open the auth page** in their browser:

   ```
   https://benchagi.com/auth/cowork?email=<email>
   ```

   (Use the base from `~/.claude/config/bench-cowork.json` `bench_api_base` if set to a non-prod URL; otherwise default to https://benchagi.com.)

3. **The user signs in** with their existing BenchAGI Firebase credentials on that page. The page exchanges their Firebase ID token for a 7-day Cowork JWT and displays it in a copy box.

4. **Prompt the user** to paste the token back into Claude Code:

   > Paste the Cowork token you copied from the browser:

5. **Validate the token shape** — must be three base64url segments separated by dots (JWT format):

   ```bash
   echo "$TOKEN" | grep -qE '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
   ```

   If it doesn't match, tell the user to re-paste and try again.

6. **Decode the payload** (middle segment, base64url → JSON) and extract `uid`, `email`, `exp`:

   ```bash
   echo "$TOKEN" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null
   ```

7. **Write the config file** at `~/.claude/config/bench-cowork.json`:

   ```json
   {
     "bench_api_base": "https://benchagi.com/api/v1",
     "bench_user_email": "<email from token>",
     "bench_user_uid": "<uid from token>",
     "bench_cowork_token": "<token>",
     "bench_cowork_expires_at": "<ISO 8601 from exp claim>",
     "bench_instance_id": null
   }
   ```

   Create `~/.claude/config/` if it doesn't exist. Use `chmod 600` on the file.

8. **Export the token** so MCP servers can see it:

   Tell the user to add this to their shell rc:

   ```bash
   export BENCH_COWORK_TOKEN="$(jq -r .bench_cowork_token ~/.claude/config/bench-cowork.json)"
   ```

   Or they can re-run `/bench-login` on each new Claude Code session (token is read from the config file by the plugin loader).

9. **Confirm success**:

   > ✅ Logged in as `<email>` (uid `<uid>`). Token expires `<ISO date>`. You can now use `@aurelius`, `@bailey`, or `/wiki-capture`.

## Edge cases

- **`$ARGUMENTS` empty**: show the current auth state from the config file (email + expiration), or "not logged in" if the file is missing.
- **Token expired when decoded**: warn and ask the user to re-run the browser flow.
- **401 from the exchange endpoint**: the user's Firebase account isn't provisioned in `identityIndex` — ask them to contact Cory (cory@benchagi.com) or Jim/Jory.
- **Server misconfig (COWORK_JWT_SECRET missing)**: the endpoint returns 500 with `COWORK_AUTH_MINT_FAILED`. Tell the user to email cory@benchagi.com.
