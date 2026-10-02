import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { extractCssAnimations } from '../css-animation-extract.mjs';

let browser;
const withPage = async (html, fn) => {
  browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    await page.waitForTimeout(150);
    return await fn(await extractCssAnimations(page));
  } finally {
    await browser.close();
  }
};

test('a running CSS animation is reported with its resolved timing', async () => {
  await withPage(`
    <style>
      @keyframes slidein { from { transform: translateX(0) } to { transform: translateX(100%) } }
      #box { animation: 3s ease-in 1s 2 reverse both slidein }
    </style>
    <div id="box"></div>`, ({ running }) => {
    const anim = running.find((a) => a.animationName === 'slidein');
    assert.ok(anim, 'the running animation is found by name');
    assert.equal(anim.playState, 'running');
    assert.equal(anim.duration, 3000);
    assert.equal(anim.target.selector, '#box');
    assert.equal(anim.direction, 'reverse');
    assert.equal(anim.fill, 'both');
  });
});

test('an element with no id gets a selector that actually resolves', async () => {
  await withPage(`
    <style>@keyframes f { to { opacity: 0 } } .a { animation: 1s linear f }</style>
    <div><span class="a"></span></div>`, ({ running }) => {
    const anim = running.find((a) => a.animationName === 'f');
    assert.ok(anim);
    assert.equal(anim.target.unique, true, 'the selector must resolve to one element');
    const sel = anim.target.selector;
    assert.ok(sel.includes('.a'), `selector should name the class, got ${sel}`);
  });
});

test('a keyframes rule nested inside @media is found', async () => {
  await withPage(`
    <style>
      @media (min-width: 1px) { @keyframes nested { to { opacity: 0 } } }
    </style>
    <div></div>`, ({ keyframes }) => {
    const rule = keyframes.find((k) => k.name === 'nested');
    assert.ok(rule, 'a flat walk would have missed this entirely');
    assert.ok(rule.inside.includes('(min-width'), `it records the condition it lives under: ${rule.inside}`);
    assert.equal(rule.steps.length, 1);
  });
});

test('the same keyframes name in two conditions is not collapsed', async () => {
  await withPage(`
    <style>
      @keyframes f { to { opacity: 0 } }
      @media (min-width: 1px) { @keyframes f { to { opacity: 1 } } }
    </style>
    <div></div>`, ({ keyframes }) => {
    assert.equal(keyframes.filter((k) => k.name === 'f').length, 2,
      'a dark-mode override is a different rule, not a duplicate');
  });
});

test('a keyframe step keeps its declarations as cssText', async () => {
  await withPage(`
    <style>@keyframes g { 50% { opacity: .5; transform: scale(2) } }</style>
    <div></div>`, ({ keyframes }) => {
    const rule = keyframes.find((k) => k.name === 'g');
    assert.equal(rule.steps[0].keyText, '50%');
    assert.match(rule.steps[0].declarations, /opacity/);
    assert.match(rule.steps[0].declarations, /scale\(2\)/);
  });
});

test('a page with no animation at all reports empty, not a throw', async () => {
  await withPage('<div>static</div>', ({ running, keyframes }) => {
    assert.deepEqual(running, []);
    assert.deepEqual(keyframes, []);
  });
});
