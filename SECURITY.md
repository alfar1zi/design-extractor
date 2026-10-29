# Security policy

## Reporting a vulnerability

Report privately through GitHub's [security advisory form](https://github.com/alfar1zi/design-extractor/security/advisories/new).
Please do not open a public issue for a vulnerability.

Include the version (`npx design-extractor --version`), the command you ran, and the
smallest input that reproduces it. A proof of concept against a site you control is
ideal; a URL you do not control is not needed.

Expect an acknowledgement within 7 days and a fix or a written assessment within 30
days. Credit is given in the release notes unless you ask otherwise.

## What counts as a vulnerability here

This tool opens a browser on a URL a user supplies and writes what it finds to disk.
The classes that matter:

- **SSRF.** Reaching a loopback, private, link-local, CGNAT, benchmark, multicast or
  reserved address that the guard in `scripts/url-safety.mjs` should have refused,
  including IPv4-mapped IPv6 forms, decimal or octal integer forms, and redirect hops.
- **Path traversal or destructive writes.** Writing outside `--out`, or clearing a
  directory this tool did not create, through `scripts/tree-writer.mjs` or the archive
  extractor.
- **Prompt injection that the skill acts on.** Captured HTML, JS strings, `alt` text,
  ARIA labels or console output that cause an agent reading the capture to execute or
  follow it. The skill documents captured content as data; a case where it is not
  treated that way is a bug.
- **Dependency compromise.** A production dependency with a known advisory, or a
  transitive install script doing something the lockfile does not describe.

## Known and accepted limits

These are documented rather than fixed, and a report about them is a documentation
request, not a vulnerability:

- **DNS rebinding between check and connect.** `assertSafeUrl` resolves and validates
  before the browser opens the page; the browser resolves again when it connects. A
  name that answers publicly at check time and privately at connect time can reach an
  internal address. Mitigate with an egress policy where the target matters.
- **A page can be hostile to the capture.** It can hang, allocate, open dialogs or
  navigate away. The run reports a partial capture and exits `3` rather than hanging
  forever, but it is not a sandbox.
- **`--allow-private` exists on purpose.** Passing it turns the address guard off.

## Scope

In scope: this repository's code, its published package, and its GitHub workflows.
Out of scope: the third-party sites a user chooses to capture, the optional
`saveweb2zip` copier that `--legacy-source` posts to, and advisories in dev-only
dependencies (they are reported by `npm audit` but do not block a release).
