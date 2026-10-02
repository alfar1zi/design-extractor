import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { simplifyRules, cascadeWinners, animatedStylesFor, matchedStylesFor, openCdp } from '../cdp.mjs';

const rule = (selector, declarations) => ({
  rule: { selectorList: { text: selector }, origin: 'regular', style: { styleSheetId: '1', cssProperties: declarations } },
});

test('rules arrive in ascending specificity, so the last declaration wins', () => {
  const winners = cascadeWinners(simplifyRules([
    rule('.b', [{ name: 'color', value: 'blue' }]),
    rule('.a', [{ name: 'color', value: 'green' }]),
    rule('#x', [{ name: 'color', value: 'red' }]),
  ]));
  assert.deepEqual(winners.color, { value: 'red', selector: '#x', important: false });
});

test('an important declaration beats a later, more specific one', () => {
  const winners = cascadeWinners(simplifyRules([
    rule('.a', [{ name: 'color', value: 'red', important: true }]),
    rule('#x', [{ name: 'color', value: 'green' }]),
  ]));
  assert.equal(winners.color.value, 'red', 'position must not override !important');
  assert.equal(winners.color.selector, '.a');
});

test('a later important declaration beats an earlier one', () => {
  const winners = cascadeWinners(simplifyRules([
    rule('.a', [{ name: 'color', value: 'red', important: true }]),
    rule('#x', [{ name: 'color', value: 'green', important: true }]),
  ]));
  assert.equal(winners.color.value, 'green');
});

test('a disabled declaration is dropped, a false active flag is not invented', () => {
  const [r] = simplifyRules([rule('.a', [{ name: 'color', value: 'red' }, { name: 'top', value: '0', disabled: true }])]);
  assert.deepEqual(r.declarations.map((d) => d.name), ['color']);
  assert.equal(r.declarations[0].active, undefined, 'CDP leaves active unset; it must not be faked');
});

test('a malformed rule does not throw', () => {
  assert.deepEqual(simplifyRules([{}, { rule: {} }]), [
    { selector: null, origin: null, styleSheetId: null, declarations: [] },
    { selector: null, origin: null, styleSheetId: null, declarations: [] },
  ]);
});

test('a live page: the engine reports the resolved animation, not a guess', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="x">a</div>');
    const cdp = await openCdp(page);
    try {
      await page.evaluate(() => {
        document.getElementById('x').animate(
          [{ transform: 'translateX(0)' }, { transform: 'translateX(50px)' }],
          { duration: 1000, easing: 'ease-in-out', iterations: 3, delay: 100, fill: 'both' },
        );
      });
      await page.waitForTimeout(200);
      const anims = animatedStylesFor(cdp);
      assert.equal(anims.length, 1, 'the animation the engine started is captured');
      assert.equal(anims[0].type, 'WebAnimation');
      assert.equal(anims[0].timing.duration, 1000);
      assert.equal(anims[0].timing.delay, 100);
      assert.equal(anims[0].timing.iterations, 3);
      assert.equal(anims[0].timing.fill, 'both');
      assert.equal(anims[0].keyframes.length, 2);
    } finally {
      await cdp.close();
    }
  } finally {
    await browser.close();
  }
});

test('a live page: matchedStylesFor names the winning rule', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<style>#x{color:red}#x{color:green}</style><div id="x">hi</div>');
    const cdp = await openCdp(page);
    try {
      const result = await matchedStylesFor(cdp, '#x');
      assert.equal(result.winners.color.value, 'green', 'the later #x rule wins');
      const computed = await page.evaluate(() => getComputedStyle(document.getElementById('x')).color);
      assert.equal(result.winners.color.value, 'green');
      assert.match(computed, /0, 128, 0/, 'and that agrees with getComputedStyle');
    } finally {
      await cdp.close();
    }
  } finally {
    await browser.close();
  }
});

test('a selector that matches nothing is null, not an empty object', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<div></div>');
    const cdp = await openCdp(page);
    try {
      assert.equal(await matchedStylesFor(cdp, '#nope'), null);
    } finally {
      await cdp.close();
    }
  } finally {
    await browser.close();
  }
});
