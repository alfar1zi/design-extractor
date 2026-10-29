// Gate: a release cannot be published under a version the manifests do not say.
//
// The tag, package.json, the lockfile, the plugin manifest, the marketplace entry
// and skill.json each carry a number. A release with them out of step ships a
// tarball whose version disagrees with the tag users pin, and nothing in a normal
// test run notices.
//
// Run: node --test scripts/__tests__/check-release.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkVersions, versionsIn } from '../check-release.mjs';

const v = (version) => [
  ['package.json', version],
  ['package-lock.json', version],
  ['.claude-plugin/plugin.json', version],
  ['.claude-plugin/marketplace.json', version],
  ['skill.json', version],
];

test('the repository as checked out has one version everywhere', async () => {
  assert.deepEqual(checkVersions(await versionsIn(), null), []);
});

test('a tag that matches the manifests passes', () => {
  assert.deepEqual(checkVersions(v('1.2.3'), 'v1.2.3'), []);
});

test('a tag without the v prefix passes too', () => {
  assert.deepEqual(checkVersions(v('1.2.3'), '1.2.3'), []);
});

test('a tag naming a different version is refused', () => {
  const problems = checkVersions(v('1.2.3'), 'v1.2.4');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /v1\.2\.4 names 1\.2\.4, manifests say 1\.2\.3/);
});

test('one manifest left behind is refused, and the odd one is named', () => {
  const pairs = v('1.2.3');
  pairs[4] = ['skill.json', '1.2.2'];
  const problems = checkVersions(pairs, null);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /1\.2\.2 \(skill\.json\)/);
  assert.match(problems[0], /1\.2\.3 \(package\.json/);
});

test('a missing version is a problem, not a silent empty string', () => {
  const pairs = v('1.2.3');
  pairs[2] = ['.claude-plugin/plugin.json', undefined];
  const problems = checkVersions(pairs, null);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /has no version/);
});

test('a non-semver version is refused, once per file that carries it', () => {
  const problems = checkVersions(v('1.2'), null);
  assert.equal(problems.length, 5);
  for (const p of problems) assert.match(p, /not semver: "1\.2"/);
});

test('a prerelease tag matches its prerelease version', () => {
  assert.deepEqual(checkVersions(v('1.2.3-beta.1'), 'v1.2.3-beta.1'), []);
});

test('a tag that is not a version is refused even when manifests agree', () => {
  const problems = checkVersions(v('1.2.3'), 'latest');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /is not vX\.Y\.Z/);
});

test('the script actually runs when invoked as a program', async () => {
  // A main-guard that never matches exits 0 having checked nothing, which is
  // exactly how a release gate passes on a tree it should have refused. On
  // Windows the old string comparison compared a backslash path against a
  // file:// URL and never fired.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const run = promisify(execFile);
  const script = fileURLToPath(new URL('../check-release.mjs', import.meta.url));

  const good = await run(process.execPath, [script]);
  assert.match(good.stdout, /every manifest agrees/);

  await assert.rejects(
    () => run(process.execPath, [script, 'v0.0.1']),
    (e) => e.code === 1 && /names 0\.0\.1/.test(e.stderr),
  );
});
