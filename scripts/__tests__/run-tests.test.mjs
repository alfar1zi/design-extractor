import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverTests, resolveTests } from '../run-tests.mjs';

async function makeFixture(prefix, files) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body);
  }
  return dir;
}

test('discoverTests returns sorted *.test.mjs basenames', async () => {
  const dir = await makeFixture('run-tests-sort-', {
    'b.test.mjs': '// b',
    'a.test.mjs': '// a',
    'helper.mjs': '// helper',
    'README.md': '# nope',
    'c.test.mjs': '// c',
  });
  try {
    const names = await discoverTests(dir);
    assert.deepEqual(names, ['a.test.mjs', 'b.test.mjs', 'c.test.mjs']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('discoverTests returns empty array for empty directory', async () => {
  const dir = await makeFixture('run-tests-empty-', {});
  try {
    const names = await discoverTests(dir);
    assert.deepEqual(names, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveTests returns absolute paths joined under testsDir', async () => {
  const dir = await makeFixture('run-tests-resolve-', {
    'a.test.mjs': '// a',
    'b.test.mjs': '// b',
  });
  try {
    const paths = resolveTests(dir, ['a.test.mjs', 'b.test.mjs']);
    assert.deepEqual(paths, [join(dir, 'a.test.mjs'), join(dir, 'b.test.mjs')]);
    for (const p of paths) {
      assert.ok(p.startsWith(dir), `${p} should start with ${dir}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('discoverTests rejects when directory does not exist', async () => {
  const missing = join(tmpdir(), `definitely-missing-${Date.now()}-${Math.random()}`);
  await assert.rejects(discoverTests(missing), /ENOENT|no such file/i);
});

test('discoverTests filters out files without .test.mjs suffix', async () => {
  const dir = await makeFixture('run-tests-filter-', {
    'real.test.mjs': '// real',
    'helper.mjs': '// helper',
    'README.md': '# nope',
    'test.mjs': '// missing .test. prefix',
    'real.test.js': '// wrong extension',
  });
  try {
    const names = await discoverTests(dir);
    assert.deepEqual(names, ['real.test.mjs']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
