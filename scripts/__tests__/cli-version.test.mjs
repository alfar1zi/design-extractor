// Gate: the three bins answer --version with the version npm publishes.
//
// A CLI without --version is not installable by a package manager that probes it,
// and a version string typed into the source disagrees with package.json the first
// time a release bumps one and not the other. Both halves are asserted here: the
// flag works, and the number it prints is the one in package.json.
//
// Run: node --test scripts/__tests__/cli-version.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BINS = ['cli.mjs', 'inspect.mjs', 'saveweb2zip.mjs'];

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

for (const bin of BINS) {
  test(`${bin} prints the package version for --version`, async () => {
    const { stdout } = await exec(process.execPath, [join(ROOT, 'scripts', bin), '--version']);
    assert.equal(stdout.trim(), pkg.version);
  });

  test(`${bin} prints the package version for -V`, async () => {
    const { stdout } = await exec(process.execPath, [join(ROOT, 'scripts', bin), '-V']);
    assert.equal(stdout.trim(), pkg.version);
  });

  test(`${bin} shows the version in its help header`, async () => {
    const { stdout } = await exec(process.execPath, [join(ROOT, 'scripts', bin), '--help']);
    assert.match(stdout.split('\n')[0], new RegExp(`\\b${pkg.version.replace(/\./g, '\\.')}\\b`));
  });
}

test('--version does not require a url', async () => {
  // The flag has to short-circuit before argument validation, or a package
  // manager probing the binary gets exit 2 and reports the install as broken.
  const { stdout } = await exec(process.execPath, [join(ROOT, 'scripts', 'cli.mjs'), '--version']);
  assert.equal(stdout.trim(), pkg.version);
});

test('no bin hardcodes a version string', async () => {
  for (const bin of BINS) {
    const src = await readFile(join(ROOT, 'scripts', bin), 'utf8');
    assert.doesNotMatch(src, /VERSION\s*=\s*['"]\d+\.\d+\.\d+/, `${bin} types its own version`);
  }
});
