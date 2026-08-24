#!/usr/bin/env node
// inspect.mjs - Playwright runtime capture for the design-extractor skill.
// Lazy-imports playwright so pure helpers can be unit-tested without browser binary installed.

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertSafeUrl } from './url-safety.mjs';
// scanAnimationLibs split to scan-libs.mjs so this file stays under the AGENTS.md 400-line cap.
import { scanAnimationLibs } from './scan-libs.mjs';
export { scanAnimationLibs };

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
const TABLET = { width: 768, height: 1024 };
const MOBILE = { width: 375, height: 812 };
const CLICK_CAP = 50;
const CLICK_WAIT_MS = 500;
const INTERACTIVE_CAP = 200;
const STABLE_INTERACTIVE_ROLES = new Set(['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'combobox']);

// ---- pure helpers (exported for tests) ----

export function defaultOutDir(url, now = new Date()) {
  let host = 'site';
  try { host = new URL(url).host.replace(/[^a-z0-9.-]/gi, '_') || 'site'; } catch { /* keep site */ }
  const p = (n) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return resolve(process.cwd(), `inspect_${host}_${ts}`);
}

export function parseArgs(argv) {
  const out = {
    url: null, outDir: null, viewport: DEFAULT_VIEWPORT, timeout: 30,
    scroll: true, interactions: true, hover: true, sweep: true, siteDir: null,
    recordVideo: false, recordHoverVideo: false, allowPrivate: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--url': out.url = next(); break;
      case '--out': out.outDir = next(); break;
      case '--site-dir': out.siteDir = next(); break;
      case '--viewport': {
        const m = /^(\d+)x(\d+)$/.exec(next() || '');
        if (!m) throw new Error('--viewport must be WxH, e.g. 1440x900');
        out.viewport = { width: Number(m[1]), height: Number(m[2]) };
        break;
      }
      case '--timeout': out.timeout = Number(next()); break;
      case '--no-scroll': out.scroll = false; break;
      case '--no-interactions': out.interactions = false; break;
      case '--no-hover': out.hover = false; break;
      case '--no-sweep': out.sweep = false; break;
      case '--record-video': out.recordVideo = true; break;
      case '--record-hover-video': out.recordHoverVideo = true; break;
      case '--allow-private': out.allowPrivate = true; break;
      case '-h': case '--help': out.help = true; break;
      default: throw new Error(`unknown flag: ${a}`);
    }
  }
  if (out.help) return out;
  if (!out.url) throw new Error('--url is required');
  try { new URL(out.url); } catch { throw new Error('--url must be a valid URL'); }
  if (!Number.isFinite(out.timeout) || out.timeout <= 0) throw new Error('--timeout must be a positive number');
  if (out.viewport.width <= 0 || out.viewport.height <= 0) throw new Error('--viewport dimensions must be positive');
  return out;
}

// Generate monotonic y positions to scroll through, capped at docHeight (Infinity if unknown).
export function stepScrollPositions(viewport, step, docHeight = Infinity) {
  const stepPx = Math.max(1, Math.floor(viewport.height * step));
  const maxY = Number.isFinite(docHeight) ? Math.max(0, docHeight - viewport.height) : Infinity;
  const positions = [];
  for (let y = 0; y <= maxY; y += stepPx) {
    if (positions.length >= 200) break;
    positions.push(y);
  }
  if (positions[0] !== 0) {
    if (positions.length >= 200) positions.pop();
    positions.unshift(0);
  }
  return positions;
}

// Walk an a11y tree and return nodes that look clickable AND stable (named + interactive role).
export function selectClickables(a11yTree) {
  const out = [];
  const walk = (node) => {
    if (!node) return;
    const role = (node.role || '').toLowerCase();
    if (STABLE_INTERACTIVE_ROLES.has(role) && (node.name || node.ariaLabel || node.value)) {
      out.push({ role, name: node.name || node.ariaLabel || node.value || '' });
    }
    if (Array.isArray(node.children)) for (const c of node.children) walk(c);
  };
  walk(a11yTree);
  return out.slice(0, CLICK_CAP);
}

// Bug 4 fix: extract only interactive elements (not the full recursive tree).
// Accepts a serialized a11y-tree node OR a DOM-snapshot array of plain objects.
export function extractInteractiveElements(root) {
  const results = [];
  const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea']);
  const walk = (node) => {
    if (!node || results.length >= INTERACTIVE_CAP) return;
    const role = (node.role || '').toLowerCase();
    const tag = (node.tag || '').toLowerCase();
    const isInteractive = (
      STABLE_INTERACTIVE_ROLES.has(role) ||
      INTERACTIVE_TAGS.has(tag) ||
      node.href ||
      node.tabIndex >= 0
    );
    if (isInteractive) {
      results.push({
        tag: tag || null,
        role: role || null,
        name: (node.name || node.ariaLabel || node.alt || node.title || '').slice(0, 80),
        href: node.href || null,
        value: node.value || null,
        outerHTML: node.outerHTML ? node.outerHTML.slice(0, 200) : null,
      });
    }
    const children = node.children || [];
    for (const c of children) walk(c);
  };
  walk(root);
  return results;
}

function safeHost(url) {
  try { return new URL(url).host; } catch { return 'unknown'; }
}

async function fileMeta(p) {
  try { return { path: p, size: (await stat(p)).size }; } catch { return { path: p, size: 0 }; }
}

// ---- pretty printing ----
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const out = (msg) => process.stdout.write(`[inspect] ${msg}\n`);
const err = (msg) => process.stderr.write(`[inspect] ${wrap('31', msg)}\n`);
const info = (m) => out(wrap('36', m));
const dim  = (m) => out(wrap('90', m));
const ok   = (m) => out(wrap('32', m));

const HELP = `design-extractor-inspect -- capture runtime state of a live page via Playwright
Usage: design-extractor-inspect --url <URL> [options]
Options:
  --url <URL>          target page (required)
  --out <DIR>          output directory (default: ./inspect_<host>_<YYYYMMDD_HHmmss>)
  --site-dir <PATH>    site source dir; if given, scans for animation libs
  --viewport WxH       primary viewport (default: 1440x900)
  --timeout <sec>      networkidle wait (default: 30)
  --no-scroll          skip scroll-through screenshot pass
  --no-interactions    skip clickable interaction pass
  --no-hover           skip hover pass (transition timing + before/after screenshots)
  --no-sweep           skip tablet+mobile viewport sweep
  --record-video       record scroll pass as webm video (slow, large; off by default)
  --record-hover-video record hover pass as webm video (one clip per element; large)
  --allow-private      allow private/loopback URLs (off by default; SSRF guard)
  -h, --help           show this help
Outputs: screenshots/, a11y-tree.json, a11y-interactive.json, tokens.json, dom.html,
         network.json, console.json, interactions.json, hover.json, animation-libs.json, manifest.json
`;

// ---- playwright runtime ----

async function launchOrHint() {
  try {
    const { chromium } = await import('playwright');
    return await chromium.launch();
  } catch (e) {
    err(`Browser launch failed: ${e.message.split('\n')[0]}`);
    err('Run `npm run install:browsers` to download Chromium, then retry.');
    process.exit(1);
  }
}

async function recordPass(context, url, viewport, timeoutSec, outDir) {
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  const net = [];
  const con = [];
  page.on('request', (r) => net.push({ url: r.url(), method: r.method(), resourceType: r.resourceType(), ts: Date.now() }));
  page.on('response', async (r) => {
    const rec = net.find((n) => n.url === r.url() && !n.status);
    if (rec) {
      rec.status = r.status();
      rec.contentType = r.headers()['content-type'] || '';
      try { rec.size = Number(r.headers()['content-length'] || 0); } catch { rec.size = 0; }
    }
  });
  page.on('console', (m) => con.push({ level: m.type(), text: m.text(), location: m.location() || null, ts: Date.now() }));
  page.on('pageerror', (e) => con.push({ level: 'error', text: `pageerror: ${e.message}`, ts: Date.now() }));

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutSec * 1000 });
  try { await page.waitForLoadState('networkidle', { timeout: timeoutSec * 1000 }); } catch { /* tolerate */ }

  const screenshotDir = join(outDir, 'screenshots');
  await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: join(screenshotDir, 'viewport.png') });
  await page.screenshot({ path: join(screenshotDir, 'full.png'), fullPage: true });

  // Build a11y tree via DOM walk (page.accessibility removed in Playwright 1.47+).
  const a11y = await page.evaluate(() => {
    const ROLES = new Set(['button','link','checkbox','menuitem','option','radio','searchbox','slider','switch','tab','textbox','heading','img','navigation','main','banner','contentinfo','form','region','article','list','listitem']);
    function walk(el, depth) {
      if (depth > 8 || !el) return null;
      const role = el.getAttribute('role') || (ROLES.has(el.tagName.toLowerCase()) ? el.tagName.toLowerCase() : (el.hasAttribute('href') ? 'link' : null));
      const name = (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || (el.textContent || '').trim().slice(0, 80)).trim();
      const children = [];
      for (const c of el.children) { const n = walk(c, depth + 1); if (n) children.push(n); }
      if (!role && !children.length) return null;
      return { role, name, tag: el.tagName.toLowerCase(), children };
    }
    return walk(document.documentElement, 0);
  }) || { role: 'root', name: '', children: [] };

  // Bug 2 fix: dump resolved CSS custom property values via getComputedStyle.
  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const PREFIXES = ['--color-', '--ease-', '--shadow-', '--radius-', '--font-size-', '--font-weight-', '--spacing-', '--border-'];
    const out = {};
    for (const prop of style) {
      if (!prop.startsWith('--')) continue;
      if (prop.startsWith('--sx-')) continue; // internal implementation vars
      if (!PREFIXES.some((p) => prop.startsWith(p))) continue;
      const val = style.getPropertyValue(prop).trim();
      if (val) out[prop] = val;
    }
    return out;
  });

  const dom = await page.content();
  const docHeight = await page.evaluate(() => document.documentElement.scrollHeight);

  return { page, a11y, tokens, dom, docHeight, net, con, screenshotDir };
}

// Bug 3 fix: use page.mouse.wheel() in 120px increments instead of window.scrollTo().
async function scrollPass(page, viewport, docHeight, screenshotDir) {
  if (!viewport) return [];
  const positions = stepScrollPositions(viewport, 0.8, docHeight);
  const files = [];
  let currentY = 0;
  for (let i = 0; i < positions.length; i++) {
    const targetY = positions[i];
    const delta = targetY - currentY;
    if (delta > 0) {
      for (let scrolled = 0; scrolled < delta; scrolled += 120) {
        const step = Math.min(120, delta - scrolled);
        await page.mouse.wheel(0, step);
        await page.waitForTimeout(80);
      }
    }
    currentY = targetY;
    await page.waitForTimeout(1500); // wait for IntersectionObserver callbacks + CSS transitions
    const p = join(screenshotDir, `scroll-${String(i + 1).padStart(2, '0')}.png`);
    await page.screenshot({ path: p });
    files.push(p);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  return files;
}

// Fresh-page-per-click: each element is clicked in its own page load, eliminating
// stale handle errors from SPA navigation. Re-queries the same selector on every
// fresh page and picks element N by index, which is stable as long as page loads
// consistently.
// Interaction + hover passes extracted to interaction-pass.mjs to keep inspect.mjs lean.
import { interactionPass, hoverPass, dismissOverlays, categorizeError, INTERACTION_CAP, INTERACTION_SEL } from './interaction-pass.mjs';
export { interactionPass, hoverPass, dismissOverlays, categorizeError, INTERACTION_CAP, INTERACTION_SEL };

async function sweepPass(browser, url, timeoutSec, screenshotDir) {
  const out = [];
  for (const [label, vp] of [['tablet', TABLET], ['mobile', MOBILE]]) {
    const ctx = await browser.newContext({ viewport: vp });
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutSec * 1000 });
      try { await page.waitForLoadState('networkidle', { timeout: timeoutSec * 1000 }); } catch { /* ignore */ }
      const p = join(screenshotDir, `${label}.png`);
      await page.screenshot({ path: p, fullPage: true });
      out.push({ viewport: label, ...vp, file: p });
    } finally {
      await ctx.close();
    }
  }
  return out;
}

// ---- main ----
async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { err(e.message); process.exit(2); }
  if (args.help) { process.stdout.write(HELP); return; }

  try { await assertSafeUrl(args.url, { allowPrivate: !!args.allowPrivate }); }
  catch (e) { err(e.message); process.exit(2); }

  const outDir = args.outDir ? resolve(args.outDir) : defaultOutDir(args.url);
  await mkdir(outDir, { recursive: true });
  info(`URL: ${args.url}`);
  dim(`OutDir: ${outDir}`);
  dim(`Viewport: ${args.viewport.width}x${args.viewport.height}  timeout: ${args.timeout}s`);

  const browser = await launchOrHint();
  // Fix 2: when --record-video, pass recordVideo option so Playwright captures the scroll pass.
  const ctxOptions = { viewport: args.viewport };
  if (args.recordVideo || args.recordHoverVideo) {
    const videoDir = join(outDir, 'videos');
    await mkdir(videoDir, { recursive: true });
    ctxOptions.recordVideo = { dir: videoDir, size: { width: args.viewport.width, height: args.viewport.height } };
  }
  const context = await browser.newContext(ctxOptions);
  let primary;
  try {
    primary = await recordPass(context, args.url, args.viewport, args.timeout, outDir);
  } catch (e) {
    await browser.close().catch(() => {});
    err(`Primary capture failed: ${e.message}`);
    process.exit(1);
  }

  const { page, a11y, tokens, dom, docHeight, net, con, screenshotDir } = primary;
  const interactive = extractInteractiveElements(a11y);
  await writeFile(join(outDir, 'a11y-tree.json'), JSON.stringify(a11y, null, 2));
  await writeFile(join(outDir, 'a11y-interactive.json'), JSON.stringify(interactive, null, 2));
  await writeFile(join(outDir, 'tokens.json'), JSON.stringify(tokens, null, 2));
  await writeFile(join(outDir, 'dom.html'), dom, 'utf8');
  await writeFile(join(outDir, 'network.json'), JSON.stringify(net, null, 2));
  await writeFile(join(outDir, 'console.json'), JSON.stringify(con, null, 2));

  const artifacts = [
    await fileMeta(join(screenshotDir, 'viewport.png')),
    await fileMeta(join(screenshotDir, 'full.png')),
    await fileMeta(join(outDir, 'a11y-tree.json')),
    await fileMeta(join(outDir, 'a11y-interactive.json')),
    await fileMeta(join(outDir, 'tokens.json')),
    await fileMeta(join(outDir, 'dom.html')),
    await fileMeta(join(outDir, 'network.json')),
    await fileMeta(join(outDir, 'console.json')),
  ];

  if (args.scroll) {
    const scrollFiles = await scrollPass(page, args.viewport, docHeight, screenshotDir);
    for (const f of scrollFiles) artifacts.push(await fileMeta(f));
    dim(`Scroll pass: ${scrollFiles.length} screenshots`);
    if (args.recordVideo) {
      const videoPath = join(outDir, 'videos', 'scroll.webm');
      await page.video().saveAs(videoPath).catch(() => {});
      artifacts.push(await fileMeta(videoPath));
      dim(`Video: ${videoPath}`);
    }
  }

  let interactions = [];
  if (args.interactions) {
    interactions = await interactionPass(context, args.url, args.timeout, screenshotDir);
    await writeFile(join(outDir, 'interactions.json'), JSON.stringify(interactions, null, 2));
    artifacts.push(await fileMeta(join(outDir, 'interactions.json')));
    dim(`Interaction pass: ${interactions.length} clickables (${interactions.filter((i) => i.error).length} errored)`);
  }

  let hovers = [];
  if (args.hover) {
    hovers = await hoverPass(context, args.url, args.timeout, screenshotDir);
    await writeFile(join(outDir, 'hover.json'), JSON.stringify(hovers, null, 2));
    artifacts.push(await fileMeta(join(outDir, 'hover.json')));
    dim(`Hover pass: ${hovers.length} hovers (${hovers.filter((h) => h.error).length} errored)`);
  }

  if (args.sweep) {
    const sweep = await sweepPass(browser, args.url, args.timeout, screenshotDir);
    for (const s of sweep) artifacts.push(await fileMeta(s.file));
    dim(`Sweep pass: ${sweep.length} viewports`);
  }

  if (args.siteDir) {
    const animLibs = await scanAnimationLibs(args.siteDir);
    await writeFile(join(outDir, 'animation-libs.json'), JSON.stringify(animLibs, null, 2));
    artifacts.push(await fileMeta(join(outDir, 'animation-libs.json')));
    dim(`Animation libs: ${Object.entries(animLibs).filter(([, v]) => v.found).map(([k]) => k).join(', ') || 'none detected'}`);
  }

  await browser.close().catch(() => {});

  const manifest = {
    url: args.url, host: safeHost(args.url), viewport: args.viewport,
    timeout: args.timeout, timestamp: new Date().toISOString(),
    docHeight, artifactCount: artifacts.length, artifacts,
    videoPath: args.recordVideo ? join(outDir, 'videos', 'scroll.webm') : null,
    hoverVideoPath: args.recordHoverVideo ? join(outDir, 'videos', 'hover.webm') : null,
  };
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  ok(`OK: ${outDir} (${artifacts.length} artifacts)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { err(e.stack || e.message); process.exit(1); });
}
