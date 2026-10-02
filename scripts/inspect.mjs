#!/usr/bin/env node
// inspect.mjs - Playwright runtime capture for the design-extractor skill.
// Playwright is lazy-imported so pure helpers unit-test without the browser binary.

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertSafeUrl } from './url-safety.mjs';
import { scanAnimationLibs } from './scan-libs.mjs';
import { motionPass, summarizeMotion, describeMotion } from './motion-pass.mjs';
import { sampleScrollTrack } from './scroll-track.mjs';
import { componentPass } from './components-pass.mjs';
import { sourcemapPass } from './sourcemap-pass.mjs';
import { detectCanvas } from './canvas-detect.mjs';
import { createCaptureStore } from './capture-store.mjs';
import { installInterceptor } from './request-intercept.mjs';
import { writeTree } from './tree-writer.mjs';
import { tokenPass } from './tokens.mjs';
import { collectUnproducible } from './unproducible.mjs';
import { findUnreproducible } from './unreproducible-pass.mjs';
import { writeManifest } from './manifest.mjs';
import { runFidelityPass } from './fidelity-pass.mjs';
import { runOptionalPasses, createAttempt } from './optional-passes.mjs';
import { targetPass } from './target.mjs';
import { recordPass } from './record-pass.mjs';

// Re-exported so a consumer reaches it from the entry point.
export { scanAnimationLibs };

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
const TABLET = { width: 768, height: 1024 };
const MOBILE = { width: 375, height: 812 };
const CLICK_WAIT_MS = 500;

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
    url: null, outDir: null, viewport: DEFAULT_VIEWPORT, timeout: 30, fidelity: null,
    scroll: true, interactions: true, hover: true, states: true, sweep: true, siteDir: null,
    recordVideo: false, recordHoverVideo: false, allowPrivate: false, help: false,
    sourcemap: false, targets: [],
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
      case '--fidelity': out.fidelity = next(); break;
      case '--no-scroll': out.scroll = false; break;
      case '--no-interactions': out.interactions = false; break;
      case '--no-hover': out.hover = false; break;
      case '--no-sweep': out.sweep = false; break;
      case '--no-states': out.states = false; break;
      case '--record-video': out.recordVideo = true; break;
      case '--record-hover-video': out.recordHoverVideo = true; break;
      case '--allow-private': out.allowPrivate = true; break;
      case '-h': case '--help': out.help = true; break;
      case '--quick':
        out.scroll = false;
        out.interactions = false;
        out.hover = false;
        out.sweep = false;
        out.states = false;
        out.sourcemap = false;
        break;
      case '--full':
        out.scroll = true;
        out.interactions = true;
        out.hover = true;
        out.sweep = true;
        out.states = true;
        out.sourcemap = true;
        break;
      case '--standard':
        // default, no change
        break;
      case '--sourcemap':
        out.sourcemap = true;
        break;
      case '--target': {
        const val = (next() || '').trim();
        if (!val) throw new Error('--target needs a CSS selector, e.g. --target ".pricing-card"');
        out.targets.push(val);
        break;
      }
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
  --timeout <sec>      page goto timeout, then 1.5s hydration wait (default: 30)
  --fidelity <dir>     score this capture's shots against a reference dir; writes fidelity.json
  --quick              CSS-native only (no scroll/interactions/hover/states/sweep)
  --standard           default: scroll, interactions, hover, states, sweep on
  --full               all passes + sourcemap fetch + AST scan
  --no-scroll          skip scroll pass    --no-interactions  skip interaction pass
  --no-hover           skip hover pass     --no-sweep         skip tablet+mobile sweep
  --no-states          skip hover/focus/checked state capture
  --target <css>       clone one element and scope motion/components/tokens to it; repeatable
  --record-video       record scroll pass as webm (slow, large)
  --record-hover-video record hover pass as webm (one clip per element)
  --allow-private      allow private/loopback URLs (SSRF guard off)
  -h, --help           show this help
Outputs: screenshots/, a11y-tree.json, a11y-interactive.json, tokens.json, dom.html,
         network.json, console.json, interactions.json, hover.json, states.json, motion.json,
         components.authoritative.json (framework-reported; absent when none found),
         components.inferred.json, unproducible.json, targets.json, fidelity.json, manifest.json
`;

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

// Re-exported so a consumer can reach the interaction helpers from the entry
// point rather than having to know which module they ended up in.
export { dismissOverlays, categorizeError, INTERACTION_CAP, INTERACTION_SEL, selectClickables, extractInteractiveElements } from './interaction-pass.mjs';
import { extractInteractiveElements } from './interaction-pass.mjs';

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
  dim(`Outdir: ${outDir}  ${args.viewport.width}x${args.viewport.height}  timeout: ${args.timeout}s`);

  const browser = await launchOrHint();
  const ctxOptions = { viewport: args.viewport };
  if (args.recordVideo || args.recordHoverVideo) {
    const videoDir = join(outDir, 'videos');
    await mkdir(videoDir, { recursive: true });
    ctxOptions.recordVideo = { dir: videoDir, size: { width: args.viewport.width, height: args.viewport.height } };
  }
  const context = await browser.newContext(ctxOptions);
  // Must be installed before any page exists, so the first document is captured too.
  const store = createCaptureStore();
  const treeRoot = join(outDir, 'tree');
  const interceptor = await installInterceptor(context, store, { allowPrivate: !!args.allowPrivate, root: treeRoot });
  let primary;
  try {
    primary = await recordPass(context, args.url, args.viewport, args.timeout, outDir, args.targets, err, store);
  } catch (e) {
    await browser.close().catch(() => {});
    err(`Primary capture failed: ${e.message}`);
    process.exit(1);
  }

  const { page, a11y, dom, docHeight, net, con, screenshotDir } = primary;
  const canvasInfo = await detectCanvas(page);
  const interactive = extractInteractiveElements(a11y);
  const tokenCounts = await tokenPass(page, outDir, { scope: args.targets });
  dim(`Tokens: ${tokenCounts.custom} custom properties, ${tokenCounts.derived} from the cascade${tokenCounts.scoped === undefined ? '' : `, ${tokenCounts.scoped} in force on the targets`}`);
  // One shape, one loop: adding a JSON artifact used to mean editing two places.
  const json = { 'a11y-tree': a11y, 'a11y-interactive': interactive, network: net, console: con };
  for (const [name, body] of Object.entries(json)) {
    await writeFile(join(outDir, `${name}.json`), JSON.stringify(body, null, 2));
  }
  await writeFile(join(outDir, 'dom.html'), dom, 'utf8');

  const artifacts = [
    await fileMeta(join(screenshotDir, 'viewport.png')),
    await fileMeta(join(screenshotDir, 'full.png')),
    await fileMeta(join(outDir, 'tokens.json')),
    await fileMeta(join(outDir, 'dom.html')),
    ...await Promise.all(Object.keys(json).map((n) => fileMeta(join(outDir, `${n}.json`)))),
  ];

  const capture = store.captureStats();
  const tree = await writeTree(store, { outDir: treeRoot });
  await writeFile(join(outDir, 'capture.json'), JSON.stringify({
    ...capture,
    redirects: store.redirects,
    blocked: interceptor.blocked(),
    tree: { written: tree.written, bytes: tree.bytes, unrewritten: tree.missed.length },
  }, null, 2));
  artifacts.push(await fileMeta(join(outDir, 'capture.json')));
  dim(`Capture: ${tree.written} files, ${Math.round(tree.bytes / 1024)}KB, ${store.missing.length} missing, ${interceptor.blockedCount()} blocked redirects`);
  if (tree.missed.length) dim(`Unrewritten references: ${tree.missed.length} (see capture.json)`);
  // The tree is on disk, so the bodies are dead weight from here. Left attached the
  // interceptor re-enters on every later pass and refills a store nothing reads
  // again, which is how peak RSS passed twice the size of the capture it held.
  await interceptor.uninstall();
  store.releaseBodies();

  // Sampled before the scroll pass, not after. Scrolling the page for the
  // screenshots is what triggers the fade-ins and parallax this is looking for;
  // by the time motion.json is written they have all already run.
  const scrollTrack = args.scroll
    ? await sampleScrollTrack(page, { steps: 8, scope: args.targets })
    : [];

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

  // Each reloads the page, so each may fail without taking the capture with it;
  // the failures come back as `partials` -> manifest.json.
  const partials = [];
  const attempt = createAttempt(partials, err);
  const optional = await runOptionalPasses({
    context, page, browser, outDir, args, screenshotDir, fileMeta, dim, err, partials, attempt,
  });
  artifacts.push(...optional.artifacts);
  if (args.siteDir) {
    const animLibs = await scanAnimationLibs(args.siteDir);
    await writeFile(join(outDir, 'animation-libs.json'), JSON.stringify(animLibs, null, 2));
    artifacts.push(await fileMeta(join(outDir, 'animation-libs.json')));
    dim(`Animation libs: ${Object.entries(animLibs).filter(([, v]) => v.found).map(([k]) => k).join(', ') || 'none detected'}`);
  }

  // Sourcemap extraction (if enabled)
  let jsSourcemap = [], jsInferred = [];
  if (args.sourcemap) ({ jsSourcemap, jsInferred } = await sourcemapPass(net, args, outDir));

  const motion = await motionPass(page, outDir, {
    scope: args.targets,
    scroll: scrollTrack,
    scrollSampled: Boolean(args.scroll),
    writeMotion: false,
  });
  dim(summarizeMotion(motion));

  const components = await componentPass(page, outDir, { scope: args.targets, motion });
  // Listed only when it exists: a size-0 entry for a file the run deliberately
  // did not write reads as a failed capture, not a page with no framework.
  if (components.wroteAuthoritative) {
    artifacts.push(await fileMeta(join(outDir, 'components.authoritative.json')));
  }
  artifacts.push(await fileMeta(join(outDir, 'components.inferred.json')));
  dim(`Components: ${components.named} named, ${components.unnamed} minified, ${components.clusters} inferred clusters`
    + (components.wroteAuthoritative ? '' : ' (no framework-reported components found)'));
  if (args.targets.length) {
    await mkdir(join(outDir, 'targets'), { recursive: true });
    const t = await targetPass(page, args.targets, outDir);
    artifacts.push(await fileMeta(join(outDir, 'targets.json')));
    dim(`Targets: ${t.found} matched, ${t.shots} photographed, ${t.missing} matched nothing`);
  }
  await mkdir(join(screenshotDir, 'unreproducible'), { recursive: true });
  const { items: perElement, crossOriginSheets } = await findUnreproducible(page, { scope: args.targets, shotDir: screenshotDir });
  const unproducible = {
    ...collectUnproducible({
      canvasInfo, truncatedMotion: motion.truncated, unnamedComponents: components.unnamed,
      crossOriginSheets,
    }),
    elements: perElement,
    howToReadElements: 'One entry per element that cannot be rebuilt from the capture,'
      + ' with a screenshot of the exact region to match against.',
  };
  await writeFile(join(outDir, 'unproducible.json'), JSON.stringify(unproducible, null, 2));
  artifacts.push(await fileMeta(join(outDir, 'unproducible.json')));
  if (unproducible.count) dim(`${unproducible.count} things on this page cannot be reproduced from the capture`);
  if (perElement.length) dim(`${perElement.length} of them pinned to individual elements, with screenshots`);

  // A WebGL hero or a video is not only a rendering problem, it is a motion
  // problem too. Carried here as well as in unproducible.json so a consumer
  // reading motion.json learns its coverage is incomplete.
  motion.unreproducible = perElement.map((e) => ({ selector: e.selector, reason: e.reason }));
  await writeFile(join(outDir, 'motion.json'), JSON.stringify(motion, null, 2));
  artifacts.push(await fileMeta(join(outDir, 'motion.json')));

  if (args.fidelity) {
    const artifact = await runFidelityPass({
      args, outDir, screenshotDir, unreproducibleItems: perElement,
      attempt, fileMeta, dim,
    });
    if (artifact) artifacts.push(artifact);
  }

  const motionCapture = describeMotion({ args, motion, canvasInfo, jsSourcemap, jsInferred });

  await browser.close().catch(() => {});

  await writeManifest({
    outDir, args, primary, docHeight, artifacts, motionCapture, capture, store, interceptor, partials,
  });
  // A run that lost a pass is not a run that worked. Exiting 0 here let a caller
  // chain `design-extractor <url> && next-step` into a directory whose states.json
  // and interactions.json were never written.
  if (partials.length) {
    err(`${partials.length} pass(es) failed - see manifest.json partialFailures`);
    process.exitCode = 3;
  }
  ok(`OK: ${outDir} (${artifacts.length} artifacts)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { err(e.stack || e.message); process.exit(1); });
}
