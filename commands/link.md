---
name: link
description: Publish locked HTML as a live Bench Page at https://benchagi.com/s/{slug}. Internal (Bench sign-in required) by default; External (--access public) opens for anyone with the link. Requires /bench-login.
---

Publish `$ARGUMENTS` as a Bench Page.

If `$ARGUMENTS` is a folder or `.html` file, run the `link` skill helper on that path. If it is empty, use the HTML folder already in this conversation (the locked localhost board / page). If they named a title, pass `--title`.

Choose the audience first, as the `link` skill describes. A page for anyone outside the workspace (a prospect, customer or partner) needs `--access public`; without it the recipient lands on the Bench sign-in page. If you cannot tell who will open it, ask.

Requires `/bench-login` first. Return the `https://benchagi.com/s/{slug}` URL, who can open it (the helper's `Who can open` line), and the revoke command. Do not email the link unless they ask.
