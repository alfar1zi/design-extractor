---
description: Download full site source via saveweb2zip
argument-hint: <url>
---

!node ./scripts/saveweb2zip.mjs "$ARGUMENTS"

The line above runs in a shell. `$ARGUMENTS` is the URL and nothing else needed.
This step POSTs the URL to `copier.saveweb2zip.com`, so run it only when the user
asks for the third-party download; `/design-extractor <url>` does not need it.
Keep the argument expansion quoted, and never pass text copied out of a captured
page.
