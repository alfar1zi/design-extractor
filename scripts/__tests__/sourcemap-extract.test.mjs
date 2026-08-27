import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFromSourceMap, sanitizeRecoveredPath, scanJsAST } from '../sourcemap-extract.mjs';

test('sanitizeRecoveredPath guards path traversal', () => {
  const outDir = 'C:\\test-out';
  // Standard paths
  assert.equal(
    sanitizeRecoveredPath(outDir, 'webpack:///src/components/Button.js').replace(/\\/g, '/'),
    'C:/test-out/sourcemap-recovered/src/components/Button.js'
  );
  assert.equal(
    sanitizeRecoveredPath(outDir, 'http://localhost:3000/assets/main.js').replace(/\\/g, '/'),
    'C:/test-out/sourcemap-recovered/assets/main.js'
  );
  assert.equal(
    sanitizeRecoveredPath(outDir, '../traversal.js').replace(/\\/g, '/'),
    'C:/test-out/sourcemap-recovered/traversal.js'
  );
});

test('scanJsAST extracts animations with full fidelity arguments', () => {
  const js = `
    gsap.to(".hero-title", { duration: 1, opacity: 0, scale: 0.5 });
    ScrollTrigger.create({
      trigger: ".scroll-trigger-el",
      start: "top center",
      end: "bottom 20%"
    });
  `;
  const res = scanJsAST(js, 'src/main.js');
  assert.equal(res.length, 2);
  
  assert.equal(res[0].callee, 'gsap.to');
  assert.equal(res[0].file, 'src/main.js');
  assert.equal(res[0].arguments[0].value, '.hero-title');
  assert.equal(res[0].arguments[1].properties.duration.value, 1);
  assert.equal(res[0].arguments[1].properties.scale.value, 0.5);

  assert.equal(res[1].callee, 'ScrollTrigger.create');
  assert.equal(res[1].arguments[0].properties.trigger.value, '.scroll-trigger-el');
});

test('extractFromSourceMap recovers files and generates animations-js-sourcemap.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sourcemap-extract-test-'));
  try {
    const map = {
      version: 3,
      sources: ['webpack:///src/App.js', 'webpack:///src/utils.js'],
      sourcesContent: [
        `gsap.from(".logo", { y: -100, ease: "bounce" });`,
        `const noAnim = true;`
      ]
    };
    const mapBase64 = Buffer.from(JSON.stringify(map)).toString('base64');
    const jsContent = `
      console.log('App bundle');
      //# sourceMappingURL=data:application/json;charset=utf-8;base64,${mapBase64}
    `;

    const res = await extractFromSourceMap(jsContent, 'http://example.com/app.js', dir);
    
    assert.equal(res.fidelity, 'js-sourcemap');
    assert.equal(res.animations.length, 1);
    assert.equal(res.animations[0].callee, 'gsap.from');
    assert.equal(res.animations[0].file, 'src/App.js');
    assert.equal(res.animations[0].arguments[0].value, '.logo');

    // Assert files exist on filesystem
    const appFile = await readFile(join(dir, 'sourcemap-recovered', 'src', 'App.js'), 'utf8');
    assert.match(appFile, /gsap.from/);

    const savedJson = JSON.parse(await readFile(join(dir, 'animations-js-sourcemap.json'), 'utf8'));
    assert.equal(savedJson.fidelity, 'js-sourcemap');
    assert.equal(savedJson.animations.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extractFromSourceMap falls back to js-inferred if sourcemap missing/invalid', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sourcemap-extract-test-'));
  try {
    const jsContent = `
      // Some minified bundle
      gsap.timeline().to(".el", { x: 100 });
      ScrollTrigger.matchMedia({ "all": function() {} });
    `;

    const res = await extractFromSourceMap(jsContent, 'http://example.com/app.js', dir);
    
    assert.equal(res.fidelity, 'js-inferred');
    assert.equal(res.animations.length, 2);
    assert.equal(res.animations[0].callee, 'gsap.timeline');
    assert.equal(res.animations[1].callee, 'ScrollTrigger.matchMedia');

    const savedJson = JSON.parse(await readFile(join(dir, 'animations-js-inferred.json'), 'utf8'));
    assert.equal(savedJson.fidelity, 'js-inferred');
    assert.equal(savedJson.animations.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
