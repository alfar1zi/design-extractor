import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readColorSchemes, schemeOverrides } from '../theme.mjs';
import { tokenPass } from '../tokens.mjs';

const schemesOf = (o) => Object.keys(o);

test('a token that holds its value across schemes is not reported as switching', () => {
  const { differs, values } = schemeOverrides({
    light: { properties: { '--radius': '0.5rem', '--background': '0 0% 100%' }, sample: [] },
    dark: { properties: { '--radius': '0.5rem', '--background': '240 10% 3.9%' }, sample: [] },
  });
  assert.deepEqual(differs, ['--background'], '--radius is identical in both, so it is not a theme token');
  assert.deepEqual(values['--background'], { dark: '240 10% 3.9%' });
  assert.equal('--radius' in values, false, 'and it carries no override entry to mislead a consumer');
});

test('a token that only one scheme declares is a gap, not a switch', () => {
  const { differs } = schemeOverrides({
    light: { properties: { '--radius': '0.5rem' }, sample: [] },
    dark: { properties: { '--brand': '#000' }, sample: [] },
  });
  assert.deepEqual(differs, [], 'neither scheme overrides the other, so there is nothing to record');
});

test('one scheme alone cannot produce a diff, and does not pretend to', () => {
  assert.deepEqual(schemeOverrides({ light: { properties: { '--a': '1px' }, sample: [] } }),
    { differs: [], values: {}, elements: [] });
  assert.deepEqual(schemeOverrides({}), { differs: [], values: {}, elements: [] });
});

test('two schemes that differ nowhere report nothing rather than every token', () => {
  const same = { '--a': '1px', '--b': '2px' };
  assert.deepEqual(schemeOverrides({
    light: { properties: same, sample: [] }, dark: { properties: { ...same }, sample: [] },
  }).differs, [], 'reporting unchanged tokens would make a theme that does not exist look real');
});

test('a theme that moves no custom property is still found on the elements themselves', () => {
  // The Tailwind shape: not one custom property changes, the theme is plain
  // colour on the body. Reporting no theme here would be a lie a rebuild acts on.
  const { differs, elements } = schemeOverrides({
    light: {
      properties: {},
      sample: [{ selector: 'body', styles: { color: 'rgb(0, 0, 0)', 'background-color': 'rgb(255, 255, 255)' } }],
    },
    dark: {
      properties: {},
      sample: [{ selector: 'body', styles: { color: 'rgb(255, 255, 255)', 'background-color': 'rgb(0, 0, 0)' } }],
    },
  });
  assert.deepEqual(differs, [], 'no token moves, and that is reported as such');
  assert.equal(elements.length, 1);
  assert.equal(elements[0].selector, 'body');
  assert.deepEqual(elements[0].changed.color, { from: 'rgb(0, 0, 0)', dark: 'rgb(255, 255, 255)' });
});

test('one element that changes two properties is one row, not two', () => {
  const base = { selector: 'body', styles: { color: 'rgb(0, 0, 0)', 'background-color': 'rgb(255, 255, 255)' } };
  const to = { selector: 'body', styles: { color: 'rgb(255, 255, 255)', 'background-color': 'rgb(0, 0, 0)' } };
  const { elements } = schemeOverrides({
    light: { properties: {}, sample: [base] }, dark: { properties: {}, sample: [to] },
  });
  assert.equal(elements.length, 1, 'the selector is the row, the properties are the cells');
  assert.deepEqual(Object.keys(elements[0].changed).sort(), ['background-color', 'color']);
});

test('an element that does not move is not listed, so the list stays worth reading', () => {
  const still = { selector: '#card', styles: { color: 'rgb(0, 0, 0)' } };
  const { elements } = schemeOverrides({
    light: { properties: {}, sample: [still] }, dark: { properties: {}, sample: [still] },
  });
  assert.deepEqual(elements, [], '150 sampled elements and none of them change is a result, not a gap');
});

test('the dark values in tokens.json come from the page actually switching, not from a copy', async () => {
  const browser = await chromium.launch();
  const dir = await mkdtemp(join(tmpdir(), 'de-scheme-'));
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>
      :root { --background: 0 0% 100%; --radius: 0.5rem; }
      @media (prefers-color-scheme: dark) { :root { --background: 240 10% 3.9%; } }
    </style><div>hi</div>`);
    await tokenPass(page, dir);
    const tokens = JSON.parse(await readFile(join(dir, 'tokens.json'), 'utf8'));
    const cs = tokens.$extensions['design-extractor'].colorSchemes;
    assert.deepEqual(cs.differs, ['--background'], 'only the token the media query overrides');
    assert.equal(cs.values['--background'].dark, '240 10% 3.9%');
    assert.equal(cs.values['--radius'], undefined, '--radius never changes, so it carries no override');
    assert.equal(tokens.counts.differingTokens, 1);

    // The page must go back to what the host prefers, or every later pass that
    // reads a media query inherits the emulation and reports a theme nobody set.
    const stillDark = await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);
    assert.equal(stillDark, false, 'the page was left pinned to the emulated scheme');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await browser.close();
  }
});

test('a media-query theme is read off both schemes, whatever the host prefers', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ colorScheme: 'dark' });
    await page.setContent(`<style>
      body { color: #000; background: #fff; }
      @media (prefers-color-scheme: dark) { body { color: #fff; background: #000; } }
    </style><p>hi</p>`);
    const schemes = await readColorSchemes(page);
    assert.deepEqual(schemesOf(schemes), ['light', 'dark']);
    // The host is dark, so the first scheme read is emulated light and must
    // differ from the second. A capture that captured the host's own scheme
    // twice would report a theme that does not change.
    const { elements } = schemeOverrides(schemes);
    assert.ok(elements.length > 0, 'the host being dark does not stop light from being sampled');
    const body = elements.find((e) => e.selector === 'body');
    assert.ok(body, `body not in ${JSON.stringify(elements.map((e) => e.selector))}`);
  } finally {
    await browser.close();
  }
});

test('every reported selector resolves back to exactly the element it was read from', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // The shape that catches the bug: same-tag elements NESTED inside same-tag
    // siblings. An ancestor then needs nth-of-type, and computing that index
    // from the leaf instead of from the ancestor reads -1, which is only
    // visible once the selector is looked up again.
    await page.setContent(`<style>
      body { color: #000 } span { color: #000 }
      @media (prefers-color-scheme: dark) { body, span { color: #fff } }
    </style>
      <div id="outer">
        <section><div><div><span>deep</span></div></div></section>
        <section><span>sibling</span></section>
      </div>`);
    const schemes = await readColorSchemes(page);
    const { elements } = schemeOverrides(schemes);
    assert.ok(elements.length > 0, 'the sample found the theme');

    // A selector that matches nothing, or two elements, is worse than no
    // selector: a rebuild applies the wrong change to the wrong node and has no
    // way to notice. nth-of-type(0) is exactly this failure.
    const bad = await page.evaluate((sels) => sels
      .map((s) => ({ s, n: (() => { try { return document.querySelectorAll(s).length; } catch { return -1; } })() }))
      .filter((r) => r.n !== 1), elements.map((e) => e.selector));
    assert.deepEqual(bad, [], 'each selector must match exactly one element');
  } finally {
    await browser.close();
  }
});
