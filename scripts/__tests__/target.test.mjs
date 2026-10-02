import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { targetPass, resolveTargets } from '../target.mjs';
import { parseArgs } from '../inspect.mjs';

async function withPage(html, fn) {
  const browser = await chromium.launch();
  const dir = await mkdtemp(join(tmpdir(), 'de-target-'));
  try {
    const page = await browser.newPage({ viewport: { width: 600, height: 400 } });
    await page.setContent(html);
    return await fn(page, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await browser.close();
  }
}

test('--target is repeatable and keeps its order', () => {
  const args = parseArgs(['--url', 'https://x.test', '--target', '.a', '--target', '#b']);
  assert.deepEqual(args.targets, ['.a', '#b']);
});

test('--target without a selector is refused, not silently ignored', () => {
  assert.throws(() => parseArgs(['--url', 'https://x.test', '--target', '  ']), /needs a CSS selector/);
});

test('a matched target carries its own markup, styles and states', async () => {
  const html = `<style>.card{background:rgb(255,0,0);color:#fff;padding:12px;transition:background-color 200ms}</style>
    <div class="card">Hello</div>`;
  await withPage(html, async (page, dir) => {
    const r = await targetPass(page, ['.card'], dir);
    assert.equal(r.found, 1);
    const out = JSON.parse(await readFile(join(dir, 'targets.json'), 'utf8'));
    const t = out.targets[0];
    assert.equal(t.found, true);
    assert.equal(t.matches, 1);
    assert.equal(t.tag, 'div');
    assert.equal(t.html, '<div class="card">Hello</div>');
    assert.equal(t.styles['background-color'], 'rgb(255, 0, 0)', 'the computed colour, not the authored one');
    assert.ok(t.styles.padding, 'geometry is captured too');
    assert.ok(['hover', 'focus'].every((s) => t.states.some((x) => x.state === s)), 'both states were tried');
    assert.ok(t.screenshot, 'a cropped screenshot is part of the unit');
  });
});

test('a hover state reports the real transition, not the fallback wait', async () => {
  const html = `<style>.b{transition:background-color 200ms}.b:hover{background:rgb(0,0,255)}</style>
    <div class="b">x</div>`;
  await withPage(html, async (page, dir) => {
    await targetPass(page, ['.b'], dir);
    const t = JSON.parse(await readFile(join(dir, 'targets.json'), 'utf8')).targets[0];
    const hover = t.states.find((s) => s.state === 'hover');
    assert.equal(hover.timing, 200, 'the declared duration, measured not guessed');
    assert.deepEqual(hover.changed['background-color'], { from: 'rgba(0, 0, 0, 0)', to: 'rgb(0, 0, 255)' });
  });
});

test('an element with no transition reports zero, not the settle wait', async () => {
  await withPage('<div class="c">x</div>', async (page, dir) => {
    await targetPass(page, ['.c'], dir);
    const t = JSON.parse(await readFile(join(dir, 'targets.json'), 'utf8')).targets[0];
    assert.equal(t.states.find((s) => s.state === 'hover').timing, 0);
  });
});

test('one dead selector does not lose the other captures', async () => {
  await withPage('<div class="a">a</div>', async (page, dir) => {
    const r = await targetPass(page, ['.a', '.nope', '.a'], dir);
    assert.equal(r.found, 2);
    assert.equal(r.missing, 1);
    const out = JSON.parse(await readFile(join(dir, 'targets.json'), 'utf8'));
    assert.equal(out.targets[1].found, false);
    assert.match(out.targets[1].reason, /no element matches/);
  });
});

test('screenshots are numbered by capture, not by selector position', async () => {
  await withPage('<div class="a">a</div>', async (page, dir) => {
    await targetPass(page, ['.nope', '.a'], dir);
    const out = JSON.parse(await readFile(join(dir, 'targets.json'), 'utf8'));
    assert.equal(out.targets[1].screenshot, 'target-1.png', 'a stale selector must not number the file 2');
  });
});

test('a matched element with no box says why there is no screenshot', async () => {
  await withPage('<style>.h{display:none}</style><div class="h">hidden</div>', async (page, dir) => {
    const r = await targetPass(page, ['.h'], dir);
    assert.equal(r.found, 1, 'it did match');
    assert.equal(r.shots, 0, 'but there was nothing to photograph');
    const t = JSON.parse(await readFile(join(dir, 'targets.json'), 'utf8')).targets[0];
    assert.equal(t.rect.width, 0);
    assert.ok(t.screenshot.error, 'a failure is reported, not swallowed into null');
  });
});

test('a match with no box does not leave a gap in the screenshot numbering', async () => {
  await withPage('<style>.h{display:none}</style><div class="h">x</div><p class="v">y</p>', async (page, dir) => {
    const r = await targetPass(page, ['.h', '.v'], dir);
    assert.deepEqual([r.found, r.shots], [2, 1]);
    const out = JSON.parse(await readFile(join(dir, 'targets.json'), 'utf8'));
    assert.equal(out.targets[0].screenshot.error !== undefined, true, 'the empty one reports the failure');
    assert.equal(out.targets[1].screenshot, 'target-1.png', 'the real one is the first file, not the second');
    const written = (await readdir(join(dir, 'targets'))).sort();
    assert.deepEqual(written, ['target-1.png'], 'no file number was skipped');
  });
});

test('resolveTargets counts every match of every selector, in order', async () => {
  await withPage('<div class="a">1</div><div class="a">2</div><p class="b">3</p>', async (page) => {
    const r = await resolveTargets(page, ['.a', '.b']);
    assert.deepEqual(r, [
      { selector: '.a', matches: 2, error: null },
      { selector: '.b', matches: 1, error: null },
    ]);
  });
});

test('a selector that matches nothing is distinct from an invalid one', async () => {
  await withPage('<div class="a">1</div>', async (page) => {
    const [dead, broken] = await resolveTargets(page, ['.nope', 'div:::bogus']);
    assert.deepEqual(dead, { selector: '.nope', matches: 0, error: null },
      'a dead selector is a typo, not a parse failure');
    assert.equal(broken.matches, 0);
    assert.ok(broken.error, 'an unparseable selector says why instead of throwing');
  });
});