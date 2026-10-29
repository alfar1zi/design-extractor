import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const BINS = {
  'design-extractor': 'cli.mjs',
  'design-extractor-inspect': 'inspect.mjs',
  'design-extractor-save': 'saveweb2zip.mjs',
};

/**
 * npm installs each bin as a .bin symlink, so argv[1] is the symlink path while
 * import.meta.url is the resolved target. An entry guard comparing those raw
 * strings never fires under `npx`, and the process exits 0 having printed
 * nothing. Invoking the real path hides it, so these tests go through a symlink.
 */
async function runViaSymlink(bin, script, args) {
  const dir = await mkdtemp(join(tmpdir(), 'de-bin-'));
  const link = join(dir, bin);
  const target = fileURLToPath(new URL(`../${script}`, import.meta.url));
  try {
    await symlink(target, link);
  } catch (e) {
    // Windows without Developer Mode or admin refuses symlinks with EPERM. The
    // guard under test is "the resolved path equals import.meta.url", which a
    // real path exercises too; only the symlink shape is lost, so say so rather
    // than reporting a platform permission as a broken bin.
    if (e.code === 'EPERM' || e.code === 'EACCES') {
      const { rm } = await import('node:fs/promises');
      await rm(dir, { recursive: true, force: true });
      return { ...(await run(process.execPath, [target, ...args], { timeout: 20000 })), viaSymlink: false };
    }
    throw e;
  }
  try {
    return { ...(await run(process.execPath, [link, ...args], { timeout: 20000 })), viaSymlink: true };
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  }
}

for (const [bin, script] of Object.entries(BINS)) {
  test(`${bin} runs when invoked through a .bin symlink`, async (t) => {
    const { stdout, stderr, viaSymlink } = await runViaSymlink(bin, script, ['--help']);
    // Named so a Windows run that could not create the link says so instead of
    // silently testing the easier shape.
    if (!viaSymlink) t.diagnostic('no symlink privilege on this host; invoked the real path');
    assert.match(stdout + stderr, new RegExp(bin.replace(/-/g, '.').split('.')[0], 'i'),
      `expected usage text, got stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
    assert.ok((stdout + stderr).includes('Usage'),
      'help must print usage, not exit silently');
  });
}

test('a bin that cannot run must not exit 0', async () => {
  // The silent-success failure mode: no output and a success code read as a
  // successful capture to any caller checking exit status alone.
  const { stdout } = await runViaSymlink('design-extractor', 'cli.mjs', ['--help']);
  assert.ok(stdout.trim().length > 0, 'empty stdout with exit 0 is the regression');
});