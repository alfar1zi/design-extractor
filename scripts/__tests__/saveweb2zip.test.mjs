import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultOutDir, parseArgs, safeJoin } from '../saveweb2zip.mjs';

test('defaultOutDir uses timestamp pattern', () => {
  const d = new Date('2026-08-22T14:09:07Z');
  const out = defaultOutDir(d);
  assert.match(out, /ref_\d{8}_\d{6}$/);
});

test('parseArgs requires --url', () => {
  assert.throws(() => parseArgs([]), /--url is required/);
});

test('parseArgs reads all flags and booleans', () => {
  const a = parseArgs(['--url', 'https://x.test', '--out', '/tmp/o', '--rename-assets', '--mobile-version', '--timeout', '60', '--json', '/tmp/m.json']);
  assert.equal(a.url, 'https://x.test');
  assert.equal(a.outDir, '/tmp/o');
  assert.equal(a.renameAssets, true);
  assert.equal(a.mobileVersion, true);
  assert.equal(a.saveStructure, false);
  assert.equal(a.timeoutSec, 60);
  assert.equal(a.json, '/tmp/m.json');
});

test('parseArgs rejects unknown flag', () => {
  assert.throws(() => parseArgs(['--url', 'x', '--nope']), /unknown flag/);
});

test('parseArgs rejects bad timeout', () => {
  assert.throws(() => parseArgs(['--url', 'x', '--timeout', '0']), /--timeout/);
});

test('safeJoin rejects absolute path', () => {
  assert.throws(() => safeJoin('/tmp/o', '/etc/passwd'), /absolute path/);
});

test('safeJoin rejects zip-slip traversal', () => {
  assert.throws(() => safeJoin('/tmp/o', '../escape.txt'), /zip-slip/);
});

test('safeJoin accepts nested relative path', () => {
  const root = tmpdir();
  const got = safeJoin(root, 'site/a/b.html');
  assert.equal(got, join(root, 'site', 'a', 'b.html'));
});

test('safeJoin rejects directory entry with .. inside', () => {
  assert.throws(() => safeJoin('/tmp/o', 'a/../../escape.txt'), /zip-slip/);
});
