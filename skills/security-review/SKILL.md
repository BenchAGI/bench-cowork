---
name: security-review
description: Complete a security review of pending changes on a branch. Focused review for vulnerabilities, auth boundaries, data-access gaps, secret leaks, and OWASP patterns. Use when changes touch authentication, authorization, data access, payment / billing, external APIs, or file uploads.
---

# Security Review (Tier D)

Security-focused review of the pending changes on the current branch. Not a substitute for a full security audit — this is the fast-feedback pass a developer does before opening a PR.

## When to trigger

- Changes touch **auth, authz, session handling** (login, token issuance, role checks, permission gates)
- Changes touch **data access** (Firestore rules, SQL queries, collection scoping)
- Changes touch **payments / billing** (Stripe, credit ledger, subscription state)
- Changes touch **external APIs** (webhooks, outbound HTTP, API keys)
- Changes touch **file uploads / downloads** (signed URLs, content-type handling, user-supplied paths)
- Changes touch **secrets** (.env, config files, token storage)
- User explicitly asks for security review

## Review checklist

### 1. Auth + authz

- [ ] Does every new route have an auth wrapper (`withAuth`, `withCoworkAuth`)?
- [ ] Is the required role / rank correctly specified? (Super-admin routes shouldn't be `publicRoute: true`.)
- [ ] Do writes include the caller's UID in the audit trail?
- [ ] Is instance scoping enforced? (`where('instanceId', '==', ctx.instanceId)`)
- [ ] Are UIDs never trusted from the request body — always from the verified token?

### 2. Input validation

- [ ] Are user-supplied strings validated against a schema or regex?
- [ ] Are max lengths enforced to prevent DoS via huge payloads?
- [ ] Are file uploads size-capped? Content-type-checked?
- [ ] Is SQL / Firestore query input sanitized? (No string concat into queries.)
- [ ] Are enum fields validated against a known set?

### 3. Output

- [ ] Does the response leak fields the caller shouldn't see? (Internal flags, other users' data, admin-only stats)
- [ ] Are error messages specific enough to debug but not so specific they leak schema?
- [ ] Are PII fields gated by role when included in responses?

### 4. Secrets + tokens

- [ ] No secrets in source code, logs, or error messages
- [ ] Tokens are never logged (check new `console.log`/`console.error` calls)
- [ ] Env vars are accessed via a typed config layer, not raw `process.env` reads scattered
- [ ] JWT signing uses `timingSafeEqual` for comparison
- [ ] Tokens have an `exp` claim and it's checked

### 5. External calls

- [ ] Outbound HTTP uses timeouts (never infinite)
- [ ] User-supplied URLs are validated against an allowlist before being fetched (SSRF)
- [ ] Redirects from user input are same-origin or allowlisted
- [ ] Webhook endpoints verify HMAC signatures

### 6. Storage

- [ ] Firestore rules updated for new collections?
- [ ] New Cloud Storage paths scoped by instance / user?
- [ ] Signed URLs have short TTLs?

### 7. Dependencies

- [ ] New packages: audited on npm? Pinned versions?
- [ ] No known CVEs in added deps (`npm audit`)?

## Output

```
## Security review — <branch or PR>

### Findings

**<severity>**: <file:line>
<what>
<why>
<fix>

### Verdict

- [ ] No issues
- [ ] Issues found, fixes proposed
- [ ] Needs redesign — <what to reconsider>
```

Severity ladder:
- **info**: informational; no action required
- **low**: hardening opportunity; can ship, should fix soon
- **medium**: should fix before merge; concrete attack path
- **high**: must fix before merge; exploitable as-written
- **critical**: stop ship; actively exploitable, affects production data or payments

## Hard rules

- **Never downgrade a finding to ship faster.** If it's a `high`, it stays a `high`.
- **Never include secrets, tokens, or private keys in the review output**, even as examples.
- **Never fix a security issue silently.** If you patch it, explicitly note what you patched.
- **Escalate to a human for `critical` findings** — don't just write them into a PR review, ping Cory directly.

## Bench monorepo specifics

- Customer data is scoped by `instanceId`. Any new collection must include it.
- Payment flows: Stripe webhook + billing endpoints need HMAC signature verification.
- Personal-space routes (Bailey): must never cross uid boundaries.
- Cowork routes: Bearer token auth via `withCoworkAuth`; per-uid rate-limit (currently stubbed — flag if a new high-volume route ships without a real limiter).
