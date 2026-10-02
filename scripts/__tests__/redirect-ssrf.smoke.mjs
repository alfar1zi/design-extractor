// Gate: the redirect target is checked, not just the URL the browser asked for.
//
// The entry URL has to be a loopback test server, so the run needs --allow-private,
// which switches off the address check. The scheme check stays on, so a redirect to
// `file://` proves the target itself is inspected. (The address check is covered
// without a browser in request-intercept.test.mjs.)
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TARGET = 'file:///etc/passwd';
const server = createServer((req, res) => {
  res.writeHead(302, { location: TARGET });
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const out = await mkdtemp(join(tmpdir(), 'de-ssrf-'));

const child = spawn(process.execPath, [
  'scripts/inspect.mjs', '--url', `http://127.0.0.1:${port}/`, '--out', out, '--allow-private',
  '--no-scroll', '--no-interactions', '--no-hover', '--no-sweep',
], { stdio: ['ignore', 'pipe', 'pipe'] });

let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });
const code = await new Promise((r) => child.on('close', r));
server.close();

console.log(`exit=${code}`);
console.log(log.trim());

const fail = (why) => { console.error(`FAIL: ${why}`); process.exit(1); };
if (/Timeout \d+ms exceeded/.test(log)) fail('navigation hung instead of being refused');

const capture = JSON.parse(await readFile(join(out, 'capture.json'), 'utf8'));
if (capture.blocked?.length !== 1) fail(`expected 1 blocked request, got ${capture.blocked?.length}`);
if (capture.blocked[0].url !== TARGET) fail(`block names the wrong URL: ${capture.blocked[0].url}`);
if (!/disallowed URL scheme/.test(capture.blocked[0].reason)) fail(`reason does not explain: ${capture.blocked[0].reason}`);
if (capture.entries.length !== 0) fail(`refused target was still captured: ${capture.entries.map((e) => e.url)}`);
console.log('OK: redirect target was inspected and refused before it was requested');
