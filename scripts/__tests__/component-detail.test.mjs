import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { DETAIL_PROPS, enrichComponents } from '../component-detail.mjs';

let browser;
let page;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});

after(async () => {
  await browser?.close();
});

// Eight distinct rules that all match a bare <div id="r">, in source order.
const EIGHT_RULES = `
  <style>
    #r { color: rgb(1, 1, 1) }
    div { color: rgb(2, 2, 2) }
    body div { color: rgb(3, 3, 3) }
    html body div { color: rgb(4, 4, 4) }
    div#r { color: rgb(5, 5, 5) }
    body > div { color: rgb(6, 6, 6) }
    :is(div) { color: rgb(7, 7, 7) }
    div:not(#other) { color: rgb(8, 8, 8) }
  </style>
  <div id="r" class="card">hi</div>`;

test('an enriched entry carries the markup, the classes and the selector it came from', async () => {
  await page.setContent(`
    <style>
      .card { background-color: rgb(0, 128, 0); color: rgb(255, 255, 255); width: 120px; height: 40px }
    </style>
    <div class="card"><span>hi</span></div>`);
  const sel = 'div.card';
  const { components } = await enrichComponents(page, [{ name: 'Card', hostSelector: sel }]);

  assert.equal(components[0].hostSelector, sel, 'the selector survives the round trip');
  assert.equal(components[0].name, 'Card', 'the fields the probe already had are kept');
  assert.equal(
    components[0].markup,
    await page.$eval(sel, (el) => el.outerHTML),
    'the markup is the element itself, children included',
  );
  assert.deepEqual(components[0].classNames, ['card']);
  assert.equal(components[0].markupTruncated, false, 'nothing was cut, and it says so');
});

test('every DETAIL_PROPS name resolves to a value, not just the ones that were set', async () => {
  // The probe is invoked as a source string, so the property list has to travel
  // inside the string. If it is ever passed as an evaluate argument instead, the
  // probe destructures nothing and this is the assertion that notices.
  await page.setContent('<div id="p">only text</div>');
  const { components } = await enrichComponents(page, [{ hostSelector: '#p' }]);
  const computed = components[0].computed;

  assert.deepEqual(Object.keys(computed), DETAIL_PROPS, 'one key per declared property');
  for (const prop of DETAIL_PROPS) {
    assert.equal(typeof computed[prop], 'string', `${prop} has a resolved string`);
  }
});

test('computed values are the ones the cascade resolved, not the ones authored', async () => {
  await page.setContent(`
    <style>
      #c { background-color: rgb(0, 128, 0); width: 120px; height: 40px; transform: translateX(5px) }
    </style>
    <div id="c">x</div>`);
  const { components } = await enrichComponents(page, [{ hostSelector: '#c' }]);
  const { computed } = components[0];

  assert.equal(computed['background-color'], 'rgb(0, 128, 0)');
  assert.equal(computed.width, '120px');
  assert.equal(computed.height, '40px');
  assert.equal(computed.transform, 'matrix(1, 0, 0, 1, 5, 0)', 'a length becomes a resolved matrix');
});

test('a matched rule is reported with the stylesheet it came from, and a miss is not', async () => {
  await page.setContent(`
    <style>
      .hit { opacity: 0.5 }
      .miss { opacity: 0.9 }
    </style>
    <div class="hit">x</div>`);
  const { components } = await enrichComponents(page, [{ hostSelector: 'div.hit' }]);
  const rules = components[0].matchedRules;

  assert.deepEqual(rules.map((r) => r.selector), ['.hit'], '.miss does not match this element');
  assert.equal(rules[0].href, 'inline', 'a <style> block has no href, and is labelled rather than blank');
  assert.match(rules[0].cssText, /opacity/);
});

test('a very long rule is cut, and the cut is a prefix of what was authored', async () => {
  // A Tailwind utility block runs to kilobytes. Emitting it whole is how one
  // matched rule makes the artifact unreadable, so it is bounded - but a
  // consumer still has to be able to paste what survived into a stylesheet.
  // Distinct property names: a declaration block keeps only the last value of a
  // repeated property, so a hundred copies of one declaration collapse to one.
  const long = `  #long { ${Array.from({ length: 120 }, (_, i) => `--pad-${i}: ${i}px;`).join(' ')} }`;
  await page.setContent(`<style>${long}</style><div id="long">x</div>`);
  const authored = await page.$eval('#long', (el) => {
    const rule = [...document.styleSheets[0].cssRules][0];
    return rule.cssText;
  });
  const { components } = await enrichComponents(page, [{ hostSelector: '#long' }]);
  const { cssText } = components[0].matchedRules[0];

  assert.ok(authored.length > 1000, 'the authored rule really is long');
  assert.ok(cssText.length < authored.length, 'it was cut');
  assert.ok(authored.startsWith(cssText), 'and what survived is still the start of the rule');
});

test('maxHtml truncates the markup, and the truncation is marked', async () => {
  const filler = 'y'.repeat(9000);
  await page.setContent(`<div id="big">${filler}</div>`);
  const whole = await page.$eval('#big', (el) => el.outerHTML);
  const { components } = await enrichComponents(
    page,
    [{ hostSelector: '#big' }],
    { maxHtml: 200 },
  );

  assert.ok(whole.length > 200, 'the element really is bigger than the cap');
  assert.equal(components[0].markup.length, 200, 'the cap is applied');
  assert.equal(components[0].markup, whole.slice(0, 200), 'and it is a prefix, not a mangled copy');
  assert.equal(components[0].markupTruncated, true, 'a cut-up markup is never passed off as whole');
});

test('markup under the cap is returned whole and is not flagged', async () => {
  await page.setContent('<div id="small"><b>ok</b></div>');
  const { components } = await enrichComponents(page, [{ hostSelector: '#small' }], { maxHtml: 4000 });

  assert.equal(components[0].markup, '<div id="small"><b>ok</b></div>');
  assert.equal(components[0].markupTruncated, false, 'a false flag, not an absent one - the consumer cannot tell the two apart otherwise');
});

test('maxRules caps the rule list, and the cap is not a fixed number', async () => {
  await page.setContent(EIGHT_RULES);
  const capped = await enrichComponents(page, [{ hostSelector: '#r' }], { maxRules: 3 });
  const full = await enrichComponents(page, [{ hostSelector: '#r' }], { maxRules: 50 });

  assert.equal(full.components[0].matchedRules.length, 8, 'all eight rules are found when the cap allows it');
  assert.equal(capped.components[0].matchedRules.length, 3, 'the cap is honoured');
  assert.deepEqual(
    capped.components[0].matchedRules.map((r) => r.selector),
    ['#r', 'div', 'body div'],
    'the kept rules are the first in source order, so cascade order is not lost',
  );
});

test('a hostSelector that matches nothing is counted, not given an empty rule list', async () => {
  await page.setContent('<div id="here">x</div>');
  const { components, withoutDetail } = await enrichComponents(page, [
    { hostSelector: '#here' },
    { hostSelector: '#not-on-this-page' },
  ]);

  assert.equal(withoutDetail, 1);
  assert.ok(components[0].computed, 'the one that resolved is enriched');
  assert.equal(components[1].computed, undefined, 'an empty rule list would read as "this element has no styles"');
  assert.equal(components[1].matchedRules, undefined);
});

test('a component with no host element is left alone and counted', async () => {
  await page.setContent('<style>#here { color: rgb(9, 9, 9) }</style><div id="here">x</div>');
  const { components, withoutDetail, sheetsRead } = await enrichComponents(page, [
    { name: 'ServerRow', hostSelector: '#here' },
    { name: 'ClientBoundary' },
  ]);
  assert.deepEqual(components[1], { name: 'ClientBoundary' }, 'untouched, not padded with empty detail');
  assert.equal(sheetsRead, 1, 'the probe still ran for the component that did resolve');
});

test('a cross-origin stylesheet is counted as blocked instead of vanishing', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/css' });
    res.end('#r { opacity: 0.25 }');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    await page.setContent(`
      <link rel="stylesheet" href="http://127.0.0.1:${port}/remote.css">
      <style>#r { color: rgb(9, 9, 9) }</style>
      <div id="r">x</div>`);
    await page.waitForFunction(() => document.styleSheets.length === 2);

    const { sheetsRead, sheetsBlocked, components } = await enrichComponents(page, [{ hostSelector: '#r' }]);

    assert.equal(sheetsBlocked, 1, 'the SecurityError is a number in the result, not a silent zero');
    assert.equal(sheetsRead, 1, 'the readable sheet still is read');
    assert.deepEqual(components[0].matchedRules.map((r) => r.selector), ['#r'], 'the blocked sheet costs its rules, not the pass');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a list with no host selectors is answered without a browser at all', async () => {
  // A caller that probed zero elements has nothing to ask the page, and the
  // zeros it gets back are honest zeros rather than a sheet census from a
  // probe that ran. A page double that throws is how that is told apart from a
  // result that merely looks the same.
  const input = [{ name: 'A' }, { name: 'B' }];
  const { components, withoutDetail, sheetsRead, sheetsBlocked } = await enrichComponents(
    { evaluate() { throw new Error('the page must not be touched'); } },
    input,
  );

  assert.equal(components, input, 'the same array comes back');
  assert.equal(withoutDetail, 2, 'both entries are counted as having no host');
  assert.equal(sheetsRead, 0);
  assert.equal(sheetsBlocked, 0);
});
