---
name: link
description: >
  Publish a locked HTML folder as a Bench Page at https://benchagi.com/s/{slug}
  so anyone with the URL can open it without logging in. Use when the operator
  says make a link, share this HTML, publish the board, encrypted link, secure
  link, shareable HTML, Bench Page, or /link. Slash /link.
---

# /link — live HTML at `/s/{slug}`

Possession of the URL is access. Recipients do not log in. Default expiry 90 days. Not end-to-end encryption.

What is on disk is what they get. Browser-only state is not included unless you bake it first.

Requires `/bench-login` first (or `BENCH_API_KEY` / `BENCH_AUTH_TOKEN` / `BENCH_COWORK_TOKEN`).

## Do

1. Confirm a folder with `index.html`, or a single `.html` file. If they are still punching localhost, do not publish unless they said `/link` now.
2. Run the helper next to this file. Do not print tokens.

```bash
python3 <this-skill-dir>/scripts/publish.py --selftest
python3 <this-skill-dir>/scripts/publish.py /path/to/locked-folder --title "Short title"
python3 <this-skill-dir>/scripts/publish.py /path/to/page.html --title "Short title"
python3 <this-skill-dir>/scripts/publish.py --revoke <slug>
```

3. Give them the printed `https://benchagi.com/s/{slug}` and the revoke command. Do not email the URL unless they ask.

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
