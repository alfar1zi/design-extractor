// Gate: a written tree must render with the network switched off.
// Run: node scripts/__tests__/offline-tree.smoke.mjs <liveDir>
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const liveDir = resolve(process.argv[2] || '/tmp/de-smoke/live');
const treeDir = join(liveDir, 'tree');
const TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json',
};

const manifest = JSON.parse(await readFile(join(liveDir, 'manifest.json'), 'utf8'));
const entry = manifest.capture.entryPath;
if (!entry) { console.error('FAIL: manifest names no tree entry'); process.exit(1); }

const server = createServer(async (req, res) => {
  const raw = new URL(req.url, 'http://x').pathname;
  // Filenames are stored as they appeared in the URL, and real ones contain
  // percent-encoding — Next.js emits names like `foo.0i6%7E4uf`. Decoding the
  // path before the lookup turns that into `foo.0i6~4uf`, misses the file that
  // is sitting on disk, and 404s an asset that was captured perfectly well.
  const stat = (p) => readFile(p).then(() => true, () => false);
  let rel = decodeURIComponent(raw).replace(/^\/+/, '');
  if (!await stat(join(treeDir, rel))) rel = raw.replace(/^\/+/, '');
  try {
    const body = await readFile(join(treeDir, rel));
    res.writeHead(200, { 'content-type': TYPES[extname(rel)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not in tree');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch();
const context = await browser.newContext();
const external = [];
const missing = [];
await context.route('**/*', (route, req) => {
  const u = req.url();
  if (!u.startsWith(`http://127.0.0.1:${port}/`)) { external.push(u); return route.abort(); }
  return route.continue();
});

const page = await context.newPage();
page.on('response', (r) => {
  // A 404 inside the tree is a captured asset the clone cannot load. The page
  // still renders enough to look fine, which is exactly why this went unnoticed:
  // fonts and images silently fell back while the smoke gate stayed green.
  if (r.status() >= 400) missing.push(`${r.status()} ${decodeURIComponent(r.url().replace(/^.*\//, ''))}`);
});
await page.goto(`http://127.0.0.1:${port}/${entry}`, { waitUntil: 'load' });
await page.waitForTimeout(1500);
const elements = await page.evaluate(() => document.getElementsByTagName('*').length);
const text = await page.evaluate(() => document.body.innerText.trim());
const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

await browser.close();
server.close();

console.log(JSON.stringify({ entry, elements, text: text.slice(0, 160), bg, externalRequests: external.length, missingAssets: missing.length }, null, 2));
const fail = (why) => { console.error(`FAIL: ${why}`); process.exit(1); };
if (external.length) fail(`${external.length} external requests: ${external.slice(0, 5).join(' ')}`);
if (elements < 10) fail(`only ${elements} elements rendered`);
if (missing.length) fail(`${missing.length} captured assets 404 when replayed: ${[...new Set(missing)].slice(0, 5).join(' ')}`);
if (text === 'not in tree') fail('the entry document was not found in the tree');
console.log('OK: tree renders offline');
