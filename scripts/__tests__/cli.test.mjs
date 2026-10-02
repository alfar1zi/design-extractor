import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseArgs, validateUrl, buildChildArgs } from '../cli.mjs';

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));

test('parseArgs requires url', () => {
  assert.throws(() => parseArgs([]), /url is required/);
});

test('parseArgs accepts positional url', () => {
  const a = parseArgs(['https://x.test/p']);
  assert.equal(a.url, 'https://x.test/p');
  assert.equal(a.outDir, null);
  assert.equal(a.viewport, '1440x900');
  assert.equal(a.timeout, 30);
  assert.equal(a.scroll, true);
  assert.equal(a.interactions, true);
  assert.equal(a.sweep, true);
  assert.equal(a.skipSave, false);
  assert.equal(a.skipInspect, false);
});

test('parseArgs parses all flags and toggles', () => {
  const a = parseArgs(['https://x.test', '--out', '/tmp/o', '--viewport', '1280x800', '--timeout', '60', '--no-scroll', '--no-interactions', '--no-sweep', '--skip-save', '--skip-inspect']);
  assert.equal(a.outDir, '/tmp/o');
  assert.equal(a.viewport, '1280x800');
  assert.equal(a.timeout, 60);
  assert.equal(a.scroll, false);
  assert.equal(a.interactions, false);
  assert.equal(a.sweep, false);
  assert.equal(a.skipSave, true);
  assert.equal(a.skipInspect, true);
});

test('parseArgs rejects bad viewport', () => {
  assert.throws(() => parseArgs(['https://x.test', '--viewport', 'wide']), /viewport/);
});

test('parseArgs rejects bad timeout', () => {
  assert.throws(() => parseArgs(['https://x.test', '--timeout', '0']), /timeout/);
});

test('parseArgs rejects unknown flag', () => {
  assert.throws(() => parseArgs(['https://x.test', '--nope']), /unknown flag/);
});

test('parseArgs --help short-circuits validation', () => {
  const a = parseArgs(['--help']);
  assert.equal(a.help, true);
  assert.equal(a.url, null);
});

test('validateUrl accepts valid', async () => {
  assert.equal(await validateUrl('https://x.com', { resolver: () => Promise.resolve([{ address: '1.1.1.1' }]) }), true);
});

test('validateUrl throws on junk', async () => {
  await assert.rejects(validateUrl('not a url'), /invalid URL/);
});

test('buildChildArgs runs inspect only by default', () => {
  const out = buildChildArgs({ out: './o', url: 'https://x.test', skipSave: false, skipInspect: false, viewport: '1440x900', timeout: 30, scroll: true, interactions: true, sweep: true });
  assert.equal(out.length, 1);
  assert.equal(out[0][0], 'inspect');
  assert.ok(out[0][1].includes('--viewport'));
  assert.ok(out[0][1].includes('1440x900'));
});

test('buildChildArgs prepends save when --legacy-source is set', () => {
  const out = buildChildArgs({ out: './o', url: 'https://x.test', legacySource: true, skipSave: false, skipInspect: false, viewport: '1440x900', timeout: 30, scroll: true, interactions: true, sweep: true });
  assert.equal(out.length, 2);
  assert.equal(out[0][0], 'save');
  assert.deepEqual(out[0][1], ['--url', 'https://x.test', '--out', join('./o', 'site')]);
  assert.equal(out[1][0], 'inspect');
});

test('buildChildArgs always emits --url flag to children (no positional URL)', () => {
  // Regression: child scripts require --url; positional was being passed and rejected.
  const out = buildChildArgs({ out: './o', url: 'https://x.test', skipSave: false, skipInspect: false, viewport: '1440x900', timeout: 30, scroll: true, interactions: true, sweep: true });
  for (const [name, argv] of out) {
    const urlIdx = argv.indexOf('--url');
    assert.notEqual(urlIdx, -1, `${name} child must receive --url flag`);
    assert.equal(argv[urlIdx + 1], 'https://x.test', `${name} child URL value must match input`);
    assert.ok(!argv.includes('https://x.test') || argv.indexOf('https://x.test') === urlIdx + 1, `${name} child must not have URL as a bare positional`);
  }
});

test('buildChildArgs skips inspect only', () => {
  const out = buildChildArgs({ out: './o', url: 'https://x.test', legacySource: true, skipSave: false, skipInspect: true, viewport: '1440x900', timeout: 30, scroll: true, interactions: true, sweep: true });
  assert.equal(out.length, 1);
  assert.equal(out[0][0], 'save');
});

test('buildChildArgs propagates no-* flags to inspect', () => {
  const out = buildChildArgs({ out: './o', url: 'https://x.test', skipSave: true, skipInspect: false, viewport: '1440x900', timeout: 30, scroll: false, interactions: false, sweep: false });
  assert.equal(out[0][0], 'inspect');
  assert.ok(out[0][1].includes('--no-scroll'));
  assert.ok(out[0][1].includes('--no-interactions'));
  assert.ok(out[0][1].includes('--no-sweep'));
});

test('buildChildArgs passes --site-dir to inspect when the legacy source step runs', () => {
  const out = buildChildArgs({ out: './o', url: 'https://x.test', legacySource: true, skipSave: false, skipInspect: false, viewport: '1440x900', timeout: 30, scroll: true, interactions: true, sweep: true });
  const inspectArgs = out.find(([n]) => n === 'inspect')[1];
  const siteIdx = inspectArgs.indexOf('--site-dir');
  assert.notEqual(siteIdx, -1, 'inspect must receive --site-dir when save runs');
  assert.equal(inspectArgs[siteIdx + 1], join('./o', 'site'));
});

test('buildChildArgs omits --site-dir when skipSave is true', () => {
  const out = buildChildArgs({ out: './o', url: 'https://x.test', legacySource: true, skipSave: true, skipInspect: false, viewport: '1440x900', timeout: 30, scroll: true, interactions: true, sweep: true });
  const inspectArgs = out.find(([n]) => n === 'inspect')[1];
  assert.ok(!inspectArgs.includes('--site-dir'), 'inspect must NOT receive --site-dir when save was skipped');
});

test('buildChildArgs omits the third-party save step unless --legacy-source is set', () => {
  const base = { out: './o', url: 'https://x.test', skipSave: false, skipInspect: false, viewport: '1440x900', timeout: 30, scroll: true, interactions: true, sweep: true };
  assert.equal(buildChildArgs(base).some(([n]) => n === 'save'), false, 'save must be opt-in: it POSTs the target URL to a third party');
  assert.equal(buildChildArgs({ ...base, legacySource: true }).some(([n]) => n === 'save'), true);
});


test('a clean capture reports its output and exits 0', async () => {
  // The one path the unit tests cannot reach. Everything above tests helpers
  // that main() composes; nothing runs main() itself, so a plain assignment
  // outside the helpers threw a ReferenceError at the very end of every
  // successful run - after the capture was written, and past every other test.
  // A script that always exits non-zero fails the calling step, and the
  // artifacts it did produce are discarded with it.
  const page = '<!doctype html><html><body><h1>hi</h1></body></html>';
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const out = await mkdtemp(join(tmpdir(), 'de-cli-'));
  let code = 0;
  let stdout = '';
  try {
    const r = await exec(process.execPath, [CLI, `http://127.0.0.1:${server.address().port}/`,
      '--out', out, '--allow-private', '--quick', '--no-scroll', '--no-interactions',
      '--no-sweep', '--no-states', '--skip-save', '--timeout', '20'], { timeout: 180000 });
    // `execFile` signals a non-zero exit by rejecting; on success it resolves
    // with no `code` property at all.
    code = r.code ?? 0; stdout = r.stdout;
  } catch (e) {
    code = e.code; stdout = e.stdout || '';
  } finally {
    await new Promise((r) => server.close(r));
    await rm(out, { recursive: true, force: true });
  }

  assert.equal(code, 0, `a capture where every pass worked exits 0; got:\n${stdout}`);
  assert.match(stdout, /live:/, 'and it names the directory it wrote');
});
