import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const INSPECT = fileURLToPath(new URL('../inspect.mjs', import.meta.url));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>probe</title>
<style>body{font:16px system-ui;margin:0;padding:20px;background:#fff}
button{padding:8px 14px;border-radius:6px;border:1px solid #ccc;background:#f6f6f6}
input{margin:8px 0}</style></head><body>
<h1>Headline</h1><p>Body copy that wraps onto more than one line so the page has height.</p>
<button id="go">Click me</button><input type="checkbox" id="c"><input id="t" placeholder="type">
<a href="/other">link</a><script>document.getElementById('go').addEventListener('click',()=>{document.body.style.background='#eef'})</script>
</body></html>`;

/** A real server, because the point is to exercise the whole inspect path. */
async function withServer(fn) {
  const server = createServer((req, res) => {
    if (req.url === '/other') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}/`); }
  finally { await new Promise((r) => server.close(r)); }
}

test('inspect runs every pass it is asked for and writes a manifest', async () => {
  // The unit tests import helpers; they never execute main(). A missing argument
  // on an internal call, a pass wired to nothing, a file nobody writes - none of
  // that shows up until the real thing runs, so the real thing has to be tested.
  const dir = await mkdtemp(join(tmpdir(), 'de-e2e-'));
  await withServer(async (url) => {
    await run(process.execPath, [INSPECT, '--url', url, '--out', dir, '--allow-private',
      '--no-scroll', '--no-sweep', '--viewport', '1024x700', '--timeout', '20'],
    { timeout: 180000 });
  });

  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  const names = manifest.artifacts.map((a) => a.path.split('/').pop());

  for (const expected of ['tokens.json', 'states.json', 'interactions.json', 'hover.json', 'motion.json', 'dom.html']) {
    assert.ok(names.includes(expected), `${expected} is listed in the manifest`);
  }
  // Interactions and hover were on, so a zero-length result means the pass ran
  // and found nothing, which this page cannot be.
  assert.ok((await stat(join(dir, 'interactions.json'))).size > 2, 'the interaction pass produced entries');
  assert.ok((await stat(join(dir, 'hover.json'))).size > 2, 'the hover pass produced entries');
  assert.equal(manifest.partialFailures, undefined, 'a run where every pass worked says nothing about failures');
});

test('a pass that cannot run is recorded in the manifest, the run exits non-zero, and the earlier artifacts survive', async () => {
  // Reproduces the failure that actually happened: a heavy site that answers the
  // first load but not the reload the interaction pass makes. Before, that took
  // the whole capture down with it - the tree, the tokens and the DOM were
  // already on disk and were thrown away by one timeout.
  //
  // The exit code is part of the contract, not an afterthought: `design-extractor
  // <url> && next-step` used to run the next step against a directory whose
  // states.json and interactions.json were never written.
  let served = 0;
  const server = createServer(async (req, res) => {
    served++;
    // The first request is the capture and succeeds. Every reload after it hangs,
    // which is what the interaction and hover passes each do.
    if (served > 1) await new Promise((r) => setTimeout(r, 4000));
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = await mkdtemp(join(tmpdir(), 'de-partial-e2e-'));
  let code = 0;
  try {
    const r = await run(process.execPath, [INSPECT, '--url', `http://127.0.0.1:${server.address().port}/`,
      '--out', dir, '--allow-private', '--no-scroll', '--no-sweep', '--no-states',
      '--viewport', '1024x700', '--timeout', '2'], { timeout: 180000 });
    code = r.code;
  } catch (e) {
    code = e.code;
  } finally { await new Promise((r) => server.close(r)); }
  assert.equal(code, 3, 'a capture that lost a pass exits 3, not 0');

  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  assert.ok(manifest.artifactCount > 0, 'the capture still produced artifacts');
  assert.ok(Array.isArray(manifest.partialFailures), 'and the failure is stated rather than swallowed');
  assert.ok(manifest.partialFailures.some((f) => f.pass === 'interactions'),
    `each failure names the pass that failed: ${JSON.stringify(manifest.partialFailures)}`);
  assert.ok((await stat(join(dir, 'tokens.json'))).size > 2, 'the tokens captured before the failure survived it');
  assert.ok((await stat(join(dir, 'dom.html'))).size > 2, 'and so did the DOM');
});
