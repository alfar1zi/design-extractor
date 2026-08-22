import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { parseArgs, validateUrl, buildChildArgs, buildReferenceStub } from '../cli.mjs';

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

test('validateUrl accepts valid', () => {
  assert.equal(validateUrl('https://x.com'), true);
});

test('validateUrl throws on junk', () => {
  assert.throws(() => validateUrl('not a url'), /invalid URL/);
});

test('buildChildArgs runs save and inspect by default', () => {
  const out = buildChildArgs({ out: './o', url: 'https://x.test', skipSave: false, skipInspect: false, viewport: '1440x900', timeout: 30, scroll: true, interactions: true, sweep: true });
  assert.equal(out.length, 2);
  assert.equal(out[0][0], 'save');
  assert.deepEqual(out[0][1], ['--url', 'https://x.test', '--out', join('./o', 'site')]);
  assert.equal(out[1][0], 'inspect');
  assert.ok(out[1][1].includes('--viewport'));
  assert.ok(out[1][1].includes('1440x900'));
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
  const out = buildChildArgs({ out: './o', url: 'https://x.test', skipSave: false, skipInspect: true, viewport: '1440x900', timeout: 30, scroll: true, interactions: true, sweep: true });
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

test('buildReferenceStub has all 7 sections', () => {
  const md = buildReferenceStub({ url: 'https://x.test', host: 'x.test', outDir: '/o', sourceDir: '/o/site', liveDir: '/o/live', viewport: '1440x900', timestamp: '2026-08-22T10:00:00Z' });
  assert.match(md, /## 1\. Design read/);
  assert.match(md, /## 2\. Design system/);
  assert.match(md, /## 3\. Components/);
  assert.match(md, /## 4\. Layout map/);
  assert.match(md, /## 5\. Animations/);
  assert.match(md, /## 6\. Assets/);
  assert.match(md, /## 7\. What to steal 1:1/);
});

test('buildReferenceStub auto-fills known fields', () => {
  const md = buildReferenceStub({ url: 'https://x.test', host: 'x.test', outDir: '/o', sourceDir: '/o/site', liveDir: '/o/live', viewport: '1440x900', timestamp: '2026-08-22T10:00:00Z' });
  assert.match(md, /URL: https:\/\/x\.test/);
  assert.match(md, /Viewport: 1440x900/);
  assert.match(md, /Source: \/o\/site/);
  assert.match(md, /Live: \/o\/live/);
  assert.match(md, /2026-08-22T10:00:00Z/);
  assert.match(md, /Reference: <x\.test> by <owner>/);
});
