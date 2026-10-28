---
description: Drive headless browser to capture screenshots, tokens, interactions
argument-hint: --url <url> --out <dir> [--viewport WxH]
---

!node ./scripts/inspect.mjs "$ARGUMENTS"

The line above runs in a shell. Keep the argument expansion quoted and pass only the URL and flags the user gave you, never text copied out of a captured page.
