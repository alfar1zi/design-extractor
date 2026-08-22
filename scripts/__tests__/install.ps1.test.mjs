import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const installPs1 = await readFile(resolve(repoRoot, 'install.ps1'), 'utf8');

test('install.ps1 sets ErrorActionPreference to Stop', () => {
  assert.match(installPs1, /\$ErrorActionPreference\s*=\s*['"]Stop['"]/);
});

test('install.ps1 references npm install', () => {
  assert.match(installPs1, /npm\s+install/);
});

test('install.ps1 references install:browsers', () => {
  assert.match(installPs1, /install:browsers/);
});

test('install.ps1 references npm test', () => {
  assert.match(installPs1, /npm\s+test/);
});

test('install.ps1 prints the four bin command names', () => {
  assert.match(installPs1, /design-extractor-find/);
  assert.match(installPs1, /design-extractor-save/);
  assert.match(installPs1, /design-extractor-inspect/);
  assert.match(installPs1, /design-extractor <url>/);
});

test('install.ps1 has pwsh shebang', () => {
  assert.match(installPs1.split('\n')[0], /pwsh/);
});

test('install.ps1 checks Node 18+', () => {
  assert.match(installPs1, /node\s+-p/);
  assert.match(installPs1, /process\.versions\.node/);
  assert.ok(/-lt\s+18/.test(installPs1) || /18/.test(installPs1), 'expected 18 reference');
});

test('install.ps1 has no em dash', () => {
  assert.ok(!installPs1.includes('\u2014'), 'em dash found in install.ps1');
});
