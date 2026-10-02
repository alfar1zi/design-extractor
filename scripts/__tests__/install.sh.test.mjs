import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const installSh = await readFile(resolve(repoRoot, 'install.sh'), 'utf8');

test('install.sh has set -e', () => {
  assert.match(installSh, /set -e/);
});

test('install.sh references npm install', () => {
  assert.match(installSh, /npm\s+install/);
});

test('install.sh references install:browsers', () => {
  assert.match(installSh, /install:browsers/);
});

test('install.sh references npm test or npm run test', () => {
  assert.ok(/npm\s+test|npm\s+run\s+test/.test(installSh), 'no npm test reference');
});

test('install.sh prints the four bin command names', () => {
  assert.match(installSh, /design-extractor-save/);
  assert.match(installSh, /design-extractor-inspect/);
  assert.match(installSh, /design-extractor <url>/);
});

test('install.sh has bash shebang', () => {
  assert.match(installSh.split('\n')[0], /bash/);
});

test('install.sh has no em dash', () => {
  assert.ok(!installSh.includes('\u2014'), 'em dash found in install.sh');
});
