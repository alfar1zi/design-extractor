import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { writeManifest } from '../manifest.mjs';

const base = (over = {}) => ({
  outDir: '',
  args: { url: 'https://x.test/page', viewport: { width: 1280, height: 720 }, timeout: 30 },
  primary: { settle: { ready: 'domcontentloaded', ms: 12 } },
  docHeight: 2400,
  artifacts: [{ path: 'a.json', size: 3 }],
  motionCapture: { total: 0 },
  capture: { entries: [1, 2], bytes: 99 },
  store: {
    missing: ['https://x.test/gone.png'],
    redirects: [],
    get: () => ({ rel: 'x.test/page.html' }),
  },
  interceptor: { blockedCount: () => 0, entryUrl: () => 'https://x.test/page' },
  ...over,
});

async function run(t, over) {
  const outDir = await mkdtemp(join(tmpdir(), 'de-man-'));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const manifest = await writeManifest(base({ ...over, outDir }));
  const onDisk = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(onDisk, manifest, 'what it returns is what it wrote');
  return { manifest, outDir };
}

test('a clean run says nothing about failures', async (t) => {
  // Absent, not `[]`. A consumer has to be able to tell "nothing went wrong"
  // from "nobody implemented this yet", and an empty array reads as the former
  // while proving nothing about the second.
  const { manifest: m } = await run(t);

  assert.equal('partialFailures' in m, false);
});

test('a pass that failed is named, with the reason', async (t) => {
  const { manifest: m } = await run(t, { partials: [{ pass: 'sweep', error: 'Timeout 30000ms exceeded' }] });

  assert.deepEqual(m.partialFailures, [{ pass: 'sweep', error: 'Timeout 30000ms exceeded' }]);
});

test('every failed pass is listed, not just the first', async (t) => {
  // The pass that throws must not cost the caller the passes that already
  // succeeded or the ones still to come.
  const { manifest: m } = await run(t, { partials: [{ pass: 'hover', error: 'a' }, { pass: 'sweep', error: 'b' }] });

  assert.deepEqual(m.partialFailures.map((p) => p.pass), ['hover', 'sweep']);
});

test('the entry page is named by its tree path', async (t) => {
  // A consumer that opens the tree needs to know which file is the one it
  // captured, and the URL alone does not say that.
  const { manifest: m } = await run(t);

  assert.equal(m.capture.treeDir, 'tree');
  assert.equal(m.capture.entryPath, 'x.test/page.html');
});

test('a URL that will not parse still yields a host field', async (t) => {
  // `host` is read by anything grouping captures by site; a throw here would
  // cost the whole manifest over a cosmetic field.
  const { manifest: m } = await run(t, { args: { ...base().args, url: 'not a url' } });

  assert.equal(m.host, 'unknown');
  assert.equal(m.url, 'not a url', 'and the original is kept rather than discarded');
});

test('what could not be captured is counted, and redirects are told apart from blocks', async (t) => {
  const { manifest: m } = await run(t, {
    store: { missing: ['a', 'b'], redirects: ['r'], get: () => null },
    interceptor: { blockedCount: () => 3, entryUrl: () => 'https://x.test/page' },
  });

  assert.equal(m.capture.missing, 2);
  assert.equal(m.capture.redirects, 1);
  assert.equal(m.capture.blockedRedirects, 3, 'a redirect the guard stopped is its own number');
  assert.equal(m.capture.entryPath, null, 'a page the store never kept has no entry path');
});

test('a video path is a path, and its absence is null', async (t) => {
  const withVideo = await run(t, { args: { ...base().args, recordVideo: true, recordHoverVideo: true } });

  assert.equal(withVideo.manifest.videoPath, join(withVideo.outDir, 'videos', 'scroll.webm'));
  assert.equal(withVideo.manifest.hoverVideoPath, join(withVideo.outDir, 'videos', 'hover.webm'));

  // A path is absolute and names a file inside the capture. A consumer can open
  // it without guessing where the run put things.
  const without = await run(t);
  assert.equal(without.manifest.videoPath, null);
  assert.equal(without.manifest.hoverVideoPath, null);
});
