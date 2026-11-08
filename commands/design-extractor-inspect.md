---
description: Drive headless browser to capture screenshots, tokens, interactions
argument-hint: <url>
---

!node ./scripts/inspect.mjs "$ARGUMENTS"

The line above runs in a shell. `$ARGUMENTS` is the URL; the pass writes to
`./inspect_<host>_<timestamp>` and prints the path. Add a flag only when the user
asked for that specific behavior (for example `--target ".pricing-card"` for one
component). Keep the argument expansion quoted, and never pass text copied out of
a captured page.
