---
description: Download full site source via saveweb2zip
argument-hint: --url <url> --out <dir>
---

!node ./scripts/saveweb2zip.mjs "$ARGUMENTS"

The line above runs in a shell. Keep the argument expansion quoted and pass only the URL and flags the user gave you, never text copied out of a captured page.
