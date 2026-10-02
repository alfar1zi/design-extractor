import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTokens, extractTokenDecls, readScopedCustomProperties, tokenPass } from '../tokens.mjs';

async function withPage(html, fn) {
  const browser = await chromium.launch();
  const dir = await mkdtemp(join(tmpdir(), 'de-tokens-'));
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    return await fn(page, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await browser.close();
  }
}

const decl = (prop, value, selector = ':root') => ({ prop, value, selector, condition: [] });

test('repeated values collapse into one token, not one per use', () => {
  const tokens = buildTokens([
    decl('color', '#333', '.a'), decl('color', '#333', '.b'), decl('color', '#333', '.c'),
    decl('color', '#fff', 'body'),
  ]);
  const dark = tokens.find((t) => t.$value === '#333');
  assert.equal(dark.$extensions['design-extractor'].uses, 3, 'three uses, one token');
  assert.equal(tokens.find((t) => t.$value === '#fff').$extensions['design-extractor'].uses, 1);
});

test('an alias stays an alias, pointing at the token it references', () => {
  const [token] = buildTokens([decl('color', 'var(--brand-500)')]);
  assert.equal(token.$value, '{brand-500}', 'flattening the alias would lose the intent');
  assert.equal(token.$extensions['design-extractor'].aliased, true);
  assert.equal(token.$type, 'color');
});

test('every token carries a DTCG type', () => {
  const tokens = buildTokens([
    decl('color', '#fff'), decl('font-size', '16px'), decl('font-weight', '700'),
    decl('border-radius', '8px'), decl('font-family', 'Inter, sans-serif'), decl('background-color', 'oklch(0.2 0.1 240)'),
  ]);
  const byValue = Object.fromEntries(tokens.map((t) => [t.$value, t.$type]));
  assert.equal(byValue['#fff'], 'color');
  assert.equal(byValue['16px'], 'dimension');
  assert.equal(byValue['700'], 'number');
  assert.equal(byValue['8px'], 'dimension');
  assert.equal(byValue['Inter, sans-serif'], 'fontFamily');
  assert.equal(byValue['oklch(0.2 0.1 240)'], 'color');
});

test('a non-colour value on a colour property is not typed as a colour', () => {
  const [token] = buildTokens([decl('color', 'inherit')]);
  assert.equal(token.$type, 'string');
});

test('a property that is not a design token is ignored', () => {
  assert.deepEqual(buildTokens([decl('z-index', '10'), decl('position', 'sticky')]), []);
});

// --brand is declared twice and --elevated only outside the scope. A stylesheet
// walk reports both --brand values; only the one on the card is in force.
const SCOPED_HTML = `<style>
  :root { --brand: #6366f1; }
  #card-a { --brand: rgb(1, 2, 3); }
  #outside { --elevated: oklch(0.2 0.1 240); }
</style>
<div id="card-a">a</div>
<div id="outside">b</div>`;

test('a token overridden on the target is reported at the target’s own value', async () => {
  const { properties } = await withPage(SCOPED_HTML, async (page) =>
    await readScopedCustomProperties(page, ['#card-a']));
  assert.equal(properties['--brand'], 'rgb(1, 2, 3)', 'the value resolved on the element, not the declaration');
});

test('a token declared only outside the scope is not reported', async () => {
  const { properties } = await withPage(SCOPED_HTML, async (page) =>
    await readScopedCustomProperties(page, ['#card-a']));
  assert.ok(!('--elevated' in properties), 'a sibling subtree’s token is not in force on the target');
});

test('a dead selector contributes nothing and an unparseable one is skipped, not thrown on', async () => {
  const { properties } = await withPage(SCOPED_HTML, async (page) => {
    assert.deepEqual(await readScopedCustomProperties(page, [')']), { properties: {}, resolvedOn: {} },
      'a selector the CSS parser rejects yields nothing rather than an exception');
    return await readScopedCustomProperties(page, ['#nope', '#card-a']);
  });
  assert.equal(properties['--brand'], 'rgb(1, 2, 3)', 'the dead selector costs nothing, the live one still resolves');
  assert.ok(!('--elevated' in properties), 'a selector matching no element pulls in the whole document');
});

test('a scoped tokenPass records the scope and what it resolves to', async () => {
  const tokens = await withPage(SCOPED_HTML, async (page, dir) => {
    await tokenPass(page, dir, { scope: ['#card-a'] });
    return JSON.parse(await readFile(join(dir, 'tokens.json'), 'utf8'));
  });
  assert.deepEqual(tokens.scope, ['#card-a']);
  assert.equal(tokens.scopedProperties['--brand'], 'rgb(1, 2, 3)');
  assert.equal(tokens.resolvedOn['--brand'], 1, 'one matched element carries it');
  assert.ok(!('--elevated' in tokens.scopedProperties));
});

test('an unscoped run claims no scope', async () => {
  const tokens = await withPage(SCOPED_HTML, async (page, dir) => {
    await tokenPass(page, dir);
    return JSON.parse(await readFile(join(dir, 'tokens.json'), 'utf8'));
  });
  assert.equal(tokens.scope, null);
  assert.ok(!('scopedProperties' in tokens), 'an unscoped run must not claim to be scoped');
  assert.ok(!('resolvedOn' in tokens));
  // Custom properties are untyped, so the cascade hands back the authored text
  // rather than a serialized colour. Unscoped, that is still the :root value.
  assert.equal(tokens.customProperties['--brand'], '#6366f1', 'unscoped, the root declaration is what counts');
});

test('a live page: tokens are read from inside @media, not only :root', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>
      :root { --brand: #6366f1; color: #6366f1; }
      @media (prefers-color-scheme: dark) { :root { color: #e5e7eb; } }
      .card { background-color: oklch(0.98 0 0); border-radius: 12px; }
    </style><div class="card">hi</div>`);
    const decls = await extractTokenDecls(page);
    // CSSOM hands back the serialized value, not the authored one: a written
    // #6366f1 reads back as rgb(99, 102, 241). Same colour, different text.
    const values = new Set(decls.map((d) => d.value));
    assert.ok(values.has('rgb(99, 102, 241)'), `got ${[...values].join(', ')}`);
    assert.ok(values.has('rgb(229, 231, 235)'), 'a dark-scheme token is a token too');
    const dark = decls.find((d) => d.value === 'rgb(229, 231, 235)');
    assert.deepEqual(dark.condition, ['(prefers-color-scheme: dark)'], 'its condition is recorded, not dropped');
    const tokens = buildTokens(decls);
    assert.ok(tokens.some((t) => t.$value === 'rgb(229, 231, 235)'), 'light and dark both survive into the token set');
    assert.ok(tokens.every((t) => t.$type), 'every token is typed');
  } finally {
    await browser.close();
  }
});

test('a live page: a cross-origin stylesheet is skipped, not crashed on', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<style>:root{color:#123456}</style><p>x</p>');
    await page.addStyleTag({ url: 'https://unpkg.com/bulma@1.0.2/css/bulma.min.css' }).catch(() => {});
    const decls = await extractTokenDecls(page);
    assert.ok(decls.length > 0, 'the readable stylesheet still yields tokens');
  } finally {
    await browser.close();
  }
});
test('the author named tokens are typed, not just recorded verbatim', async () => {
  // The gap this closes: --card was captured but never classified, so a rebuild
  // had the string and no way to know it is a colour.
  const { customTokenType, groupCustomProperties } = await import('../tokens.mjs');
  assert.equal(customTokenType('radius', '.625rem'), 'dimension');
  assert.equal(customTokenType('card', 'lab(100% 0 0)'), 'color');
  assert.equal(customTokenType('brand', '#6366f1'), 'color');
  assert.equal(customTokenType('tint', 'color-mix(in oklab, red, blue)'), 'color');
  assert.equal(customTokenType('alpha', '100%'), 'number');
  assert.equal(customTokenType('aspect-video', '16 / 9'), 'number');
  assert.equal(customTokenType('font', '"Geist Mono", monospace'), 'fontFamily');
  assert.equal(customTokenType('header-height', 'calc(.25rem * 16)'), 'dimension',
    'a calc carries no type of its own, so the name decides');
  assert.equal(customTokenType('anything', 'calc(1 + 1)'), 'string',
    'a name that says nothing about length gets the safe type');

  // An alias has no type of its own, so the properties that consume it decide.
  assert.equal(customTokenType('fg', 'var(--card)', ['color']), 'color');
  assert.equal(customTokenType('fg', 'var(--card)', []), null,
    'an alias nothing consumes has no evidence, and guessing from the name would invent a decision');

  const { collectAliasUses } = await import('../tokens.mjs');
  const uses = collectAliasUses([
    { prop: 'color', value: 'var(--fg)' },
    { prop: 'background-color', value: 'var(--card)' },
  ]);
  const groups = groupCustomProperties(
    { '--radius': '.625rem', '--card': 'lab(100% 0 0)', '--fg': 'var(--card)', '--unused': 'var(--nothing)' },
    uses,
  );
  assert.equal(groups.color.$type, 'color');
  assert.equal(groups.dimension.$type, 'dimension');
  assert.equal(groups.dimension.radius.$value, '.625rem');
  assert.equal(groups.color.fg.$value, '{card}', 'an alias keeps the reference rather than flattening it');
  assert.equal(groups._untyped, 1, 'the alias nothing consumes is counted, not silently dropped');
  assert.equal('unused' in (groups.color || {}), false, 'and it is not filed under a guessed type');
});

test('a group names the token without its -- prefix, so a rebuild can address it', async () => {
  const { groupCustomProperties } = await import('../tokens.mjs');
  const groups = groupCustomProperties({ '--primary': '#000', '--border-radius': '4px' });
  assert.deepEqual(Object.keys(groups.color), ['$type', 'primary']);
  assert.deepEqual(Object.keys(groups.dimension), ['$type', 'border-radius']);
  assert.equal(groups._untyped, 0, 'nothing had to be left out of this set');
});
