---
name: A capture is wrong or incomplete
about: An artifact says something the page does not, or a pass failed
labels: [bug]
---

**What you ran**

```
<paste the exact command, including flags>
```

**Version**

```
npx design-extractor --version
node --version
```

**What you expected, and what the artifact says**

Name the file and the field. A capture that is missing something is usually
described there already:

- `capture.json` `missing[]` / `uncaptured[]`
- `unproducible.json` `count` and `elements[]`
- `manifest.json` `partialFailures[]`

**Exit code**

`0`, `3`, `2` or `1`. `3` means a pass failed and the artifacts are still on disk.

**Site**

A URL is optional. A minimal page that reproduces it, or the fixture under
`scripts/__tests__/fixtures/`, is far more useful and does not depend on a live site
that will change tomorrow.
