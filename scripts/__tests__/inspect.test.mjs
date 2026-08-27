import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs, defaultOutDir, stepScrollPositions, selectClickables, extractInteractiveElements, scanAnimationLibs } from '../inspect.mjs';
import { categorizeError, dismissOverlays } from '../interaction-pass.mjs';

test('parseArgs requires --url', () => {
  assert.throws(() => parseArgs([]), /--url is required/);
});

test('parseArgs rejects invalid URL', () => {
  assert.throws(() => parseArgs(['--url', 'not a url']), /--url/);
});

test('parseArgs parses all flags', () => {
  const a = parseArgs(['--url', 'https://x.test/p', '--out', '/tmp/o', '--viewport', '1280x720', '--timeout', '45', '--no-scroll', '--no-interactions', '--no-sweep']);
  assert.equal(a.url, 'https://x.test/p');
  assert.equal(a.outDir, '/tmp/o');
  assert.deepEqual(a.viewport, { width: 1280, height: 720 });
  assert.equal(a.timeout, 45);
  assert.equal(a.scroll, false);
  assert.equal(a.interactions, false);
  assert.equal(a.sweep, false);
});

test('parseArgs rejects bad viewport format', () => {
  assert.throws(() => parseArgs(['--url', 'https://x.test', '--viewport', 'wide']), /viewport/);
});

test('parseArgs defaults scroll/interactions/sweep to true', () => {
  const a = parseArgs(['--url', 'https://x.test']);
  assert.equal(a.scroll, true);
  assert.equal(a.interactions, true);
  assert.equal(a.sweep, true);
  assert.deepEqual(a.viewport, { width: 1440, height: 900 });
});

test('defaultOutDir uses host and timestamp', () => {
  const out = defaultOutDir('https://example.com/foo', new Date('2026-08-22T10:00:00Z'));
  assert.match(out, /inspect_example\.com_\d{8}_\d{6}$/);
});

test('defaultOutDir falls back when URL is junk', () => {
  const out = defaultOutDir('not a url', new Date('2026-08-22T10:00:00Z'));
  assert.match(out, /inspect_site_\d{8}_\d{6}$/);
});

test('stepScrollPositions is monotonic and starts at 0', () => {
  const pos = stepScrollPositions({ width: 1440, height: 900 }, 0.8);
  assert.equal(pos[0], 0);
  for (let i = 1; i < pos.length; i++) assert.ok(pos[i] > pos[i - 1], `pos[${i}] not monotonic`);
});

test('stepScrollPositions caps at docHeight', () => {
  const pos = stepScrollPositions({ width: 1440, height: 900 }, 0.8, 1500);
  assert.ok(pos[pos.length - 1] <= 1500 - 900, 'last pos beyond viewport floor');
  assert.ok(pos.every((p) => p >= 0 && p <= 1500));
});

test('stepScrollPositions with Infinity runs but caps at 200', () => {
  const pos = stepScrollPositions({ width: 1440, height: 900 }, 0.8, Infinity);
  assert.ok(pos.length <= 200);
  assert.equal(pos[0], 0);
});

test('selectClickables returns only stable role+name nodes', () => {
  const tree = {
    role: 'root', name: '', children: [
      { role: 'button', name: 'Sign up', children: [] },
      { role: 'link', name: 'Docs', children: [] },
      { role: 'heading', name: 'Big Title', children: [] },         // not interactive
      { role: 'button', name: '', children: [] },                   // unnamed, dropped
      { role: 'text', value: 'foo', children: [] },                 // not in role set
      { role: 'menuitem', name: 'File', children: [] },
    ],
  };
  const out = selectClickables(tree);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((o) => o.role), ['button', 'link', 'menuitem']);
  assert.deepEqual(out.map((o) => o.name), ['Sign up', 'Docs', 'File']);
});

test('selectClickables caps at 50', () => {
  const children = [];
  for (let i = 0; i < 80; i++) children.push({ role: 'button', name: `B${i}`, children: [] });
  const out = selectClickables({ role: 'root', name: '', children });
  assert.equal(out.length, 50);
});

test('selectClickables accepts ariaLabel fallback', () => {
  const tree = { role: 'link', ariaLabel: 'open menu', children: [] };
  const out = selectClickables(tree);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'open menu');
});

test('extractInteractiveElements returns only interactive nodes', () => {
  const root = {
    role: 'root', tag: 'html', name: '', children: [
      { role: 'button', tag: 'button', name: 'Get started', children: [] },
      { role: 'link',   tag: 'a',      name: 'Docs', href: 'https://docs.test', children: [] },
      { role: 'heading', tag: 'h1',    name: 'Big Title', children: [] },   // not interactive
      { role: 'img',     tag: 'img',   name: 'logo', children: [] },        // not interactive
      { role: 'textbox', tag: 'input', name: 'Email', value: '', children: [] },
    ],
  };
  const out = extractInteractiveElements(root);
  assert.ok(out.length >= 3, `expected >= 3 interactive, got ${out.length}`);
  const roles = out.map((n) => n.role);
  assert.ok(roles.includes('button'));
  assert.ok(roles.includes('link'));
  assert.ok(roles.includes('textbox'));
  const link = out.find((n) => n.role === 'link');
  assert.equal(link.href, 'https://docs.test');
  assert.ok(!roles.includes('heading'));
});

test('extractInteractiveElements caps at 200', () => {
  const children = [];
  for (let i = 0; i < 250; i++) children.push({ role: 'button', tag: 'button', name: `B${i}`, children: [] });
  const out = extractInteractiveElements({ role: 'root', tag: 'html', name: '', children });
  assert.ok(out.length <= 200);
});

test('scanAnimationLibs detects gsap in stub js file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scan-test-'));
  const jsDir = join(dir, 'js');
  await mkdir(jsDir);
  await writeFile(join(jsDir, 'bundle.js'), 'const gsap = require("gsap"); gsap.to(".box", {x:100});');
  await writeFile(join(jsDir, 'other.js'), '// no animation libs here');
  const result = await scanAnimationLibs(dir);
  assert.equal(result.gsap.found, true);
  assert.ok(result.gsap.files.some((f) => f.includes('bundle.js')));
  assert.equal(result.ScrollTrigger.found, false);
  assert.equal(result.framerMotion.found, false);
});

test('scanAnimationLibs returns all-false for empty dir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scan-empty-'));
  const result = await scanAnimationLibs(dir);
  assert.ok(Object.values(result).every((v) => !v.found));
});

test('categorizeError maps timeout messages to timeout', () => {
  assert.equal(categorizeError(new Error('Timeout 8000ms exceeded')), 'timeout');
});

test('categorizeError maps pointer-intercept messages to intercepted', () => {
  assert.equal(categorizeError(new Error('element intercepts pointer events')), 'intercepted');
});

test('categorizeError maps not-found messages to not-found', () => {
  assert.equal(categorizeError(new Error('locator: foo not found')), 'not-found');
});

test('categorizeError falls back to error for unknown messages', () => {
  assert.equal(categorizeError(new Error('random')), 'error');
});

test('categorizeError returns ok for falsy input', () => {
  assert.equal(categorizeError(null), 'ok');
  assert.equal(categorizeError(undefined), 'ok');
});

test('dismissOverlays clicks every visible selector via dispatch', async () => {
  const clicked = [];
  const dispatch = async (sel) => ({
    isVisible: async () => true,
    click: async () => { clicked.push(sel); },
  });
  await dismissOverlays(null, dispatch);
  assert.ok(clicked.length >= 10, `expected at least 10 selectors clicked, got ${clicked.length}`);
  assert.ok(clicked.every((s) => s.length > 0));
});

test('dismissOverlays swallows errors from dispatch without throwing', async () => {
  const dispatch = async () => { throw new Error('selector not present'); };
  await dismissOverlays(null, dispatch); // must not throw
});

// Preset flag tests
test('parseArgs --quick sets scroll/interactions/hover/sweep/sourcemap false', () => {
  const a = parseArgs(['--url', 'https://x.test', '--quick']);
  assert.equal(a.scroll, false);
  assert.equal(a.interactions, false);
  assert.equal(a.hover, false);
  assert.equal(a.sweep, false);
  assert.equal(a.sourcemap, false);
});

test('parseArgs --full sets all true and sourcemap true', () => {
  const a = parseArgs(['--url', 'https://x.test', '--full']);
  assert.equal(a.scroll, true);
  assert.equal(a.interactions, true);
  assert.equal(a.hover, true);
  assert.equal(a.sweep, true);
  assert.equal(a.sourcemap, true);
});

test('parseArgs --standard (no flag) keeps defaults sourcemap false', () => {
  const a = parseArgs(['--url', 'https://x.test']);
  // defaults: scroll, interactions, hover, sweep = true, sourcemap = false
  assert.equal(a.scroll, true);
  assert.equal(a.interactions, true);
  assert.equal(a.hover, true);
  assert.equal(a.sweep, true);
  assert.equal(a.sourcemap, false);
});

test('parseArgs --no-scroll overrides --full', () => {
  const a = parseArgs(['--url', 'https://x.test', '--full', '--no-scroll']);
  assert.equal(a.scroll, false);
  assert.equal(a.interactions, true);
  assert.equal(a.hover, true);
  assert.equal(a.sweep, true);
  assert.equal(a.sourcemap, true);
});
