import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCaptureStore } from '../capture-store.mjs';
import { writeTree } from '../tree-writer.mjs';

function put(store, url, body, contentType) {
  store.put(
    { url: () => url, method: () => 'GET', resourceType: () => 'document', isNavigationRequest: () => false },
    { url: () => url, status: () => 200, headers: () => ({ 'content-type': contentType }) },
    Buffer.from(body),
  );
}

async function tempDir(t) {
  const d = await mkdtemp(join(tmpdir(), 'de-tree-'));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}

test('what the store holds is what lands on disk', async (t) => {
  const dir = await tempDir(t);
  const store = createCaptureStore();
  put(store, 'https://x.test/index.html', '<h1>hi</h1>', 'text/html');
  put(store, 'https://x.test/a.css', 'body{color:red}', 'text/css');

  const result = await writeTree(store, { outDir: dir });

  assert.equal(result.written, 2);
  // A `<base href>` is injected so the document's own relative URLs resolve the
  // way they did on the site; that prefix is the point, not noise.
  assert.match(await readFile(join(dir, 'x.test', 'index.html'), 'utf8'), /<h1>hi<\/h1>/);
  assert.equal(await readFile(join(dir, 'x.test', 'a.css'), 'utf8'), 'body{color:red}');
});


test("a second run does not leave the first one's files behind", async (t) => {
  // The failure this guards is silent: the tree looks complete and every file in
  // it is from some run, but not all of them are from the run you just did.
  const dir = await tempDir(t);
  const first = createCaptureStore();
  put(first, 'https://x.test/old-only.html', 'old', 'text/html');
  await writeTree(first, { outDir: dir });

  const second = createCaptureStore();
  put(second, 'https://x.test/new-only.html', 'new', 'text/html');
  await writeTree(second, { outDir: dir });

  assert.ok(existsSync(join(dir, 'x.test', 'new-only.html')));
  assert.equal(existsSync(join(dir, 'x.test', 'old-only.html')), false, 'the previous run left a file nobody asked for');
});

test('a root reached through a symlink is cleared without destroying the target', async (t) => {
  // The two halves of this were once in tension and the wrong resolution deleted
  // the user's files: `rm` on a symlink unlinks the link, while `rm` on its
  // resolved path removes the directory behind it, whatever was in there.
  const real = await tempDir(t);
  const link = join(real, '..', `de-link-${process.pid}`);
  await writeFile(join(real, 'important.txt'), 'keep me');
  await symlink(real, link, 'dir');

  const store = createCaptureStore();
  put(store, 'https://x.test/a.css', 'body{}', 'text/css');
  await writeTree(store, { outDir: link });
  // The link is unlinked and replaced by a real directory. Whatever the user had
  // symlinked `--out` at is left exactly as it was.
  assert.equal(existsSync(join(real, 'important.txt')), true, 'the directory the link pointed at survived');
  assert.equal(existsSync(join(link, 'x.test', 'a.css')), true, 'and the tree was written where --out pointed');
});

test('a traversal in a captured path cannot land outside the tree', async (t) => {
  const dir = await tempDir(t);
  const outside = join(dir, '..', `de-escape-${process.pid}`);
  const store = createCaptureStore();
  store.put(
    { url: () => 'https://x.test/../../escape.html', method: () => 'GET', resourceType: () => 'document', isNavigationRequest: () => false },
    { url: () => 'https://x.test/../../escape.html', status: () => 200, headers: () => ({ 'content-type': 'text/html' }) },
    Buffer.from('pwned'),
  );
  const result = await writeTree(store, { outDir: dir });

  // Where the file ends up is not the claim; where it must not is. `..` is
  // collapsed on the way in, so the entry is written somewhere legal.
  assert.equal(existsSync(outside), false, 'nothing was written beside the tree');
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) { if (await walk(join(d, e.name))) return true; }
      else return true;
    }
    return false;
  };
  assert.equal(await walk(dir), true, 'the file is still inside the tree');
  assert.equal(result.written, 1);
});


test('an asset that was never captured is reported, not silently dropped', async (t) => {
  const dir = await tempDir(t);
  const store = createCaptureStore();
  // An `<img>` to a host that was never captured: the tree cannot point at it,
  // and a consumer needs to know rather than get a page with a hole in it. An
  // `<a href>` would not do - navigation targets are not assets, and are
  // deliberately left alone.
  put(store, 'https://x.test/index.html', '<img src="https://gone.test/p.png">', 'text/html');

  const result = await writeTree(store, { outDir: dir });

  assert.equal(result.written, 1);
  assert.deepEqual(result.missed.map((m) => m.url), ['https://gone.test/p.png']);
  assert.ok(result.missed[0].rel, 'and it says which document referenced it');
});
