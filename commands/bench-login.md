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

7. **Write the initial config file** at `~/.claude/config/bench-cowork.json`:

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

7a. **Resolve the tenant ID** by calling `GET /api/me/identity` with the fresh token:

   ```bash
   API_BASE=$(jq -r '.bench_api_base // "https://benchagi.com/api/v1"' ~/.claude/config/bench-cowork.json)
   API_ORIGIN="${API_BASE%/}"
   API_ORIGIN="${API_ORIGIN%/api/v1}"
   API_ORIGIN="${API_ORIGIN%/api}"
   IDENTITY_FILE=$(mktemp)
   IDENTITY_STATUS=$(curl -sS -o "$IDENTITY_FILE" -w "%{http_code}" \
     -H "Authorization: Bearer $TOKEN" \
     "$API_ORIGIN/api/me/identity" || true)

   INSTANCE_ID=""
   INSTANCE_NAME=""
   if [ "$IDENTITY_STATUS" = "200" ] && jq -e . "$IDENTITY_FILE" >/dev/null 2>&1; then
     INSTANCE_ID=$(jq -r '.instanceId // empty' "$IDENTITY_FILE" \
       | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
     INSTANCE_NAME=$(jq -r '.instanceName // empty' "$IDENTITY_FILE")
   else
     echo "Warning: /me/identity lookup failed (HTTP ${IDENTITY_STATUS:-curl error}); leaving bench_instance_id null." >&2
   fi
   rm -f "$IDENTITY_FILE"
   ```

   The endpoint returns `{uid, email, instanceId, instanceName, isSuperAdmin}` for the authed caller. `instanceId` is `null` for users with no tenant binding (BenchAGI-master operators); leave the config field at `null` in that case. If the call fails, log a warning but don't block the login — the server still resolves the tenant per request.

   Update the config in place when a tenant ID came back:

   ```bash
   if [ -n "$INSTANCE_ID" ]; then
     jq --arg id "$INSTANCE_ID" '.bench_instance_id = $id' \
       ~/.claude/config/bench-cowork.json > ~/.claude/config/bench-cowork.json.tmp \
       && mv ~/.claude/config/bench-cowork.json.tmp ~/.claude/config/bench-cowork.json \
       && chmod 600 ~/.claude/config/bench-cowork.json
   fi
   ```

8. **Export the token** so MCP servers can see it:

   Tell the user to add this to their shell rc:

   ```bash
   export BENCH_COWORK_TOKEN="$(jq -r .bench_cowork_token ~/.claude/config/bench-cowork.json)"
   ```

   Or they can re-run `/bench-login` on each new Claude Code session (token is read from the config file by the plugin loader).

9. **Confirm success**:

   > ✅ Logged in as `<email>` (uid `<uid>`). Token expires `<ISO date>`.
   > Tenant: `<instanceName>` (`<instanceId>`) — or "no tenant binding" when instanceId came back null.
   > You can now use `@aurelius`, `@bailey`, or `/wiki-capture`. View your full account at https://benchagi.com/app/account (also reachable from the avatar in the bottom-left of the web app sidebar).

## Edge cases

- **`$ARGUMENTS` empty**: show the current auth state from the config file (email + expiration + instance binding), or "not logged in" if the file is missing.
- **Token expired when decoded**: warn and ask the user to re-run the browser flow.
- **401 from the exchange endpoint**: the user's Firebase account isn't provisioned in `identityIndex` — ask them to contact Cory (cory@benchagi.com) or Jim/Jory.
- **Server misconfig (COWORK_JWT_SECRET missing)**: the endpoint returns 500 with `COWORK_AUTH_MINT_FAILED`. Tell the user to email cory@benchagi.com.
- **`/me/identity` lookup fails (network blip, invalid JSON, 5xx)**: log a warning, leave `bench_instance_id: null` in the config. Login still succeeds — the server resolves tenant per request, so MCP calls work without the cached value. Re-run `/bench-login` later to retry the identity lookup.
