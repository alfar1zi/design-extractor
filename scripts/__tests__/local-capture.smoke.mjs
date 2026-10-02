// Gate: the capture still works end to end against a real page.
//
// This used to capture https://tailwindcss.com, which made CI depend on a
// third party: a redesign there turns a genuine regression into a green run,
// and an outage turns CI red for a reason that has nothing to do with this
// repo. The fixture is the same shadcn+scroll-motion page the fidelity test
// uses, so CI measures this tool rather than someone else's DNS.
//
// Run: node scripts/__tests__/local-capture.smoke.mjs [outDir]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('fixtures/shadcn-gsap', import.meta.url));
const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const out = process.argv[2] || '/tmp/de-smoke';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  try {
    const body = await readFile(join(FIXTURE, rel));
    res.writeHead(200, { 'content-type': TYPES[extname(rel)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const child = spawn(process.execPath, [
  CLI, url, '--out', out, '--quick', '--allow-private',
  '--no-scroll', '--no-interactions', '--no-sweep', '--no-states',
], { stdio: ['ignore', 'pipe', 'pipe'], cwd: join(dirname(CLI), '..') });

let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });
const code = await new Promise((r) => child.on('close', r));
await new Promise((r) => server.close(r));

const fail = (why) => { console.error(`FAIL: ${why}\n${log.trim()}`); process.exit(1); };
if (code !== 0) fail(`the capture exited ${code}`);

// An exit code of 0 is the CLI's claim about itself. These are the artifacts a
// consumer opens, so their absence has to fail the gate too. They land under
// `<out>/live`, which is also where the offline gate below looks.
for (const rel of ['manifest.json', 'capture.json', 'unproducible.json']) {
  try {
    await stat(join(out, 'live', rel));
  } catch {
    fail(`live/${rel} was not written`);
  }
}


console.log(log.trim().split('\n').slice(-12).join('\n'));
console.log(`OK: captured ${url} into ${out}`);
