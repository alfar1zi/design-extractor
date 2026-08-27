import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractCssAnimations, saveCssAnimations } from '../css-animation-extract.mjs';

test('extracts CSS active animations and keyframes rules from fixture', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            @keyframes slidein {
              from { transform: translateX(0%); }
              to { transform: translateX(100%); }
            }
            .box {
              width: 100px;
              height: 100px;
              background: red;
              animation: 3s ease-in 1s 2 reverse both slidein;
            }
          </style>
        </head>
        <body>
          <div class="box" id="test-box"></div>
        </body>
      </html>
    `;

    await page.setContent(html);
    // Wait brief frame for CSSOM parsing
    await page.waitForTimeout(200);

    const results = await extractCssAnimations(page);
    console.log('RESULTS:', JSON.stringify(results, null, 2));
    
    // Assert keyframes rule exists
    const keyframes = results.find(r => r.type === 'keyframes-rule' && r.name === 'slidein');
    assert.ok(keyframes, 'should extract slidein keyframes rule');
    assert.equal(keyframes.steps.length, 2);
    
    // Assert active animation exists
    const active = results.find(r => r.type === 'active-animation' && r.animationName === 'slidein');
    assert.ok(active, 'should extract active animation on box');
    assert.equal(active.selector, '#test-box');
    assert.equal(active.playState, 'running');

    // Verify saveCssAnimations
    const dir = await mkdtemp(join(tmpdir(), 'css-anim-test-'));
    try {
      const res = await saveCssAnimations(page, dir);
      assert.ok(res.path.endsWith('animations-css.json'));
      assert.ok(res.count >= 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    await browser.close();
  }
});
