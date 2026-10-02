// Gate: the published tarball actually contains the tool.
//
// `npm pack` honours .npmignore and the `files` list. A staging mistake there
// ships a package with no `scripts/` and no `skills/`: the CLI still exists,
// every path inside it is missing, and nothing fails until a user installs it.
// The unit suite runs from the working tree and cannot see any of this.
//
// Run: node scripts/__tests__/pack-contents.smoke.mjs
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), 'de-pack-'));
try {
  const { stdout } = await exec('npm', ['pack', '--dry-run', '--json'], { cwd: process.cwd() });
  const [tarball] = JSON.parse(stdout);
  const files = tarball.files.map((f) => f.path);

  const required = [
    ['install.sh', 'the documented install path'],
    ['scripts/cli.mjs', 'the entry point every command in the README runs'],
    ['scripts/inspect.mjs', 'the capture itself'],
    ['scripts/fidelity.mjs', 'the scoring a --fidelity run depends on'],
    ['skills/design-extractor/SKILL.md', 'the skill the package exists to publish'],
  ];
  const missing = required.filter(([p]) => !files.includes(p));
  if (missing.length) {
    for (const [p, why] of missing) console.error(`  missing: ${p}  (${why})`);
    console.error(`FAIL: ${missing.length}/${required.length} required paths are not in the tarball`);
    process.exit(1);
  }

  // The fixture ships with the tests, and a 400-line test file does not belong
  // in a user's node_modules. Not fatal on its own, but it is the first thing
  // that grows without anyone deciding to grow it.
  const fixtures = files.filter((f) => f.startsWith('scripts/__tests__/fixtures/'));
  const smoke = files.filter((f) => f.endsWith('.smoke.mjs'));
  console.log(`OK: ${files.length} files in the tarball`
    + `${fixtures.length ? `, including ${fixtures.length} fixture files` : ''}`
    + `${smoke.length ? `, including ${smoke.length} smoke gates` : ''}`);

  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  if (!pkg.version) { console.error('FAIL: package.json has no version'); process.exit(1); }
  console.log(`OK: ${pkg.name}@${pkg.version}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
