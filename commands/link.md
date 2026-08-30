---
name: link
description: Publish locked HTML as a live Bench Page at https://benchagi.com/s/{slug}. Anyone with the URL can open it without logging in. Requires /bench-login.
---

Publish `$ARGUMENTS` as a Bench Page.

If `$ARGUMENTS` is a folder or `.html` file, run the `link` skill helper on that path. If it is empty, use the HTML folder already in this conversation (the locked localhost board / page). If they named a title, pass `--title`.

Requires `/bench-login` first. Return the `https://benchagi.com/s/{slug}` URL and the revoke command. Do not email the link unless they ask.
