import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanAnimationLibs, walkJsFiles } from '../scan-libs.mjs';

// Build a fixture mimicking Next.js + Vite bundle layout.
async function buildNextJsFixture(root) {
  await mkdir(join(root, '_next', 'static', 'chunks'), { recursive: true });
  await mkdir(join(root, 'static', 'js'), { recursive: true });
  await writeFile(join(root, '_next', 'static', 'chunks', 'main-abc.js'),
    'window.__NEXT_DATA__; import { useAnimate } from "framer-motion";');
  await writeFile(join(root, 'static', 'js', 'app-def.js'),
    'Lenis smooth scroll polyfill v1.0');
}

test('recursively scans _next/static/chunks/ (Next.js bundle layout)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scan-libs-'));
  try {
    await buildNextJsFixture(dir);
    const result = await scanAnimationLibs(dir);
    assert.equal(result.framerMotion.found, true, 'should detect framer-motion in deep chunk');
    assert.equal(result.Lenis.found, true, 'should detect Lenis in static/js/');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('skips node_modules and source maps by default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scan-libs-'));
  try {
    await mkdir(join(dir, 'node_modules'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'lib.js'), 'gsap hero animation');
    await writeFile(join(dir, 'app.js'), 'no animation lib here');
    await writeFile(join(dir, 'app.js.map'), 'gsap fake');
    const result = await scanAnimationLibs(dir);
    assert.equal(result.gsap.found, false, 'node_modules and .map must be skipped');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('respects maxFiles cap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scan-libs-'));
  try {
    for (let i = 0; i < 50; i++) {
      await writeFile(join(dir, `file-${i}.js`), 'gsap test');
    }
    const files = await walkJsFiles(dir, { maxFiles: 10 });
    assert.equal(files.length, 10, `expected exactly 10 candidates, got ${files.length}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('returns empty results for directory with no .js files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scan-libs-'));
  try {
    await writeFile(join(dir, 'index.html'), '<html></html>');
    const result = await scanAnimationLibs(dir);
    for (const lib of Object.keys(result)) {
      assert.equal(result[lib].found, false, `${lib} should be not-found`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('skips binary and font extensions in candidates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scan-libs-'));
  try {
    await writeFile(join(dir, 'logo.png'), 'gsap fake');
    await writeFile(join(dir, 'font.woff2'), 'gsap fake');
    await writeFile(join(dir, 'real.js'), 'gsap real');
    const files = await walkJsFiles(dir);
    assert.equal(files.length, 1, 'only real.js should be a candidate');
    assert.ok(files[0].endsWith('real.js'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detects multiple libs across nested directories in one pass', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scan-libs-'));
  try {
    await mkdir(join(dir, 'a', 'b'), { recursive: true });
    await mkdir(join(dir, 'c'), { recursive: true });
    await writeFile(join(dir, 'a', 'b', 'gsap-bundle.js'), 'gsap.from(".hero", {y: 100})');
    await writeFile(join(dir, 'c', 'motion.js'), 'import { animate } from "framer-motion"');
    const result = await scanAnimationLibs(dir);
    assert.equal(result.gsap.found, true);
    assert.equal(result.framerMotion.found, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
