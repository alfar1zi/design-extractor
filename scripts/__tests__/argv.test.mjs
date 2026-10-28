import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeArgv } from '../argv.mjs';

test('separate arguments are left exactly as they are', () => {
  const argv = ['https://x.test', '--out', './o', '--target', '.a b'];
  assert.deepEqual(normalizeArgv(argv), argv);
});

test('a single token without whitespace is left as one argument', () => {
  assert.deepEqual(normalizeArgv(['https://x.test/']), ['https://x.test/']);
});

test('one quoted string is split into the arguments it holds', () => {
  assert.deepEqual(
    normalizeArgv(['https://x.test --out ./o --viewport 1440x900']),
    ['https://x.test', '--out', './o', '--viewport', '1440x900'],
  );
});

test('runs of whitespace collapse and edges are trimmed', () => {
  assert.deepEqual(normalizeArgv(['  https://x.test\t--out   ./o  ']), ['https://x.test', '--out', './o']);
});

test('quotes inside the string group a value that contains spaces', () => {
  assert.deepEqual(
    normalizeArgv(['https://x.test --target ".pricing card" --target nav']),
    ['https://x.test', '--target', '.pricing card', '--target', 'nav'],
  );
  assert.deepEqual(normalizeArgv(["https://x.test --target '.a b'"]), ['https://x.test', '--target', '.a b']);
});

test('a quote inside a value is not swallowed, and no shell expansion happens', () => {
  // The string is only split; nothing is expanded, so a literal $ or backtick
  // survives as text for parseArgs and assertSafeUrl to judge.
  assert.deepEqual(normalizeArgv(['https://x.test/a$(id) --out ./o']), ['https://x.test/a$(id)', '--out', './o']);
  assert.deepEqual(normalizeArgv(['https://x.test/`id`']), ['https://x.test/`id`']);
});

test('empty and missing input do not throw', () => {
  assert.deepEqual(normalizeArgv([]), []);
  assert.deepEqual(normalizeArgv(undefined), undefined);
  assert.deepEqual(normalizeArgv(['']), ['']);
});
