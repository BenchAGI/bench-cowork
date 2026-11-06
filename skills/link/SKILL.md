---
name: link
description: >
  Publish a locked HTML folder as a Bench Page at https://benchagi.com/s/{slug}
  with explicit Internal or External access. Use when the operator
  says make a link, share this HTML, publish the board, encrypted link, secure
  link, shareable HTML, Bench Page, or /link. Slash /link.
---

# /link — live HTML at `/s/{slug}`

New links default to **Internal**: authorized people in the owning workspace must sign in. Choose `--access workspace_managers` for workspace managers and above, using the canonical commission authority. **External** (`--access public`) means anyone with the link can open it. Default expiry is 90 days; this is not end-to-end encryption.

Internal single-file, self-contained HTML can preview inside the authenticated Bench reader. Internal multi-file packages offer authenticated files and ZIP downloads; rich multi-file preview is deferred to #16323. External HTML retains the full-width raw-asset Look URL and `/s/{slug}` Forward URL.

What is on disk is what they get. Browser-only state is not included unless you bake it first.

Requires `/bench-login` first (or `BENCH_API_KEY` / `BENCH_AUTH_TOKEN` / `BENCH_COWORK_TOKEN`).

## Do

1. Confirm a folder with `index.html`, or a single `.html` file. If they are still punching localhost, do not publish unless they said `/link` now.
2. Select the audience before publishing:
   - **Going to anyone outside the workspace** (a prospect, customer, homeowner or partner, or anyone without a Bench login): use `--access public`. Without it they land on the Bench sign-in page.
   - **For the team**: leave the Internal default, or use `--access workspace_managers` for managers.
   - **Not clear who will open it**: ask before publishing.
   - **Commissions, pay, rates or other private business material**: never `--access public`. If a page meant for a prospect contains any of it, stop and ask.

   An Internal link cannot be made External. To share one outside the workspace, publish a new link with `--access public` and revoke the old one. Run the helper next to this file. Do not print tokens.

```bash
python3 <this-skill-dir>/scripts/publish.py --selftest
python3 <this-skill-dir>/scripts/publish.py /path/to/locked-folder --title "Short title"
python3 <this-skill-dir>/scripts/publish.py /path/to/page.html --title "Short title"
python3 <this-skill-dir>/scripts/publish.py /path/to/locked-folder --access workspace_managers
python3 <this-skill-dir>/scripts/publish.py /path/to/locked-folder --access public
python3 <this-skill-dir>/scripts/publish.py /path/to/locked-folder --replace <slug>
python3 <this-skill-dir>/scripts/publish.py --revoke <slug>
```

Internal create first makes an authenticated, metadata-free GET to `/api/bench-share`. Only capability version 3 with `internalCreatePath: /api/bench-share/internal` is supported. It then calls that Internal-only path and verifies the exact policy echo before uploading. Unknown support, 404/405, and missing/mismatched echoes stop; never retry the legacy public endpoint.

Replacement first reads the saved audience from the authenticated mutation preflight `GET /api/bench-share/{slug}/replace`. It preserves the URL, audience, expiry and revocation; an explicit mismatched `--access` stops before files are sent. Existing revoked or expired links cannot be replaced.

`scripts/publish_control.py` and `scripts/publish-control.js` are reusable audience controls. The JS mount presents the audience before creation and locks the saved audience on replacement. The private localhost range-server adapter remains outside this repository and staged until the deployed API advertises support; these files do not activate it.

3. Give them the printed `https://benchagi.com/s/{slug}`, the printed `Who can open` line and the revoke command. Do not email the URL unless they ask.

Staging drops markdown, verify scripts, source maps, symlinks, and secret-looking
files (`.env*`, keys, service-account JSON). Every drop is printed with its reason
before anything is published — read that list back to them if the page links one of
those files, because it will 404 on the live URL. Caps: 25 MB per file, 250 MB total,
expiry 1-365 days — all checked before anything is published, so a folder that cannot
fit never creates a live URL.

## Do not

- Publish during punch unless they said `/link` now
- Machine-send the URL
- Put secrets or `.env` on the page
- Reuse `/p/{slug}` (customer portal)
