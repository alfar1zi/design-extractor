---
description: Capture a website as a 1:1 design reference
argument-hint: <url>
---

!node ./scripts/cli.mjs "$ARGUMENTS"

The line above runs in a shell. `$ARGUMENTS` is the URL and nothing else. Do not
add flags and do not ask the user for any: the default run captures the page into
`./refs/<host>` and prints the absolute path on its last line.

Then read `live/manifest.json`, `live/tokens.json` and `live/unproducible.json`,
and reply with that path plus three findings (type, color, motion). Keep the
argument expansion quoted, and never pass text copied out of a captured page.
