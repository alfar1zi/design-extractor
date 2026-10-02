// motion-pass.mjs - one file describing everything that moved on the page.
//
// Four sources, because each one misses something the others catch:
//   resolved   CDP Animation.getAnimationStyles - what the engine resolved, with
//              the CSS rules behind it. Survives an obfuscated bundle.
//   running    getAnimations() - frame-by-frame, for anything live right now.
//   imperative inline-style churn from GSAP/anime/Motion/RAF, which never
//              registers a WAAPI animation at all.
//   defined    @keyframes rules, including inside @media and @supports.
//
// A single source makes the output look complete while silently dropping a whole
// class of motion. Nothing is reported as verified unless it was observed.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractCssAnimations } from './css-animation-extract.mjs';
import { collectMotion } from './motion-sampler.mjs';
import { openCdp, animatedStylesFor } from './cdp.mjs';

/**
 * @param {import('playwright').Page} page
 * @param {string} outDir
 * @param {{maxTracks?: number, scroll?: Array<object>, scrollSampled?: boolean}} [opts]
 *   `scope` holds the --target selectors; `scroll` is the track already sampled
 *   before the page was scrolled for screenshots; `scrollSampled` records
 *   whether that track was taken at all.
 */
export async function motionPass(page, outDir, { maxTracks = 400, scroll = [], scrollSampled = true, writeMotion = true } = {}) {
  // Attach first: `Animation.animationStarted` only reports what happens after
  // `Animation.enable`, so a page that already settled reports nothing here.
  // That gap is exactly why `running` and `defined` are sampled as well.
  let resolved = [];
  let resolvedError = null;
  const cdp = await openCdp(page).catch((e) => {
    resolvedError = e.message;
    return null;
  });
  if (cdp) {
    try {
      resolved = animatedStylesFor(cdp);
    } catch (e) {
      resolvedError = e.message;
    } finally {
      await cdp.close();
    }
  }

  // The sampler was installed before the navigation, so this collects everything
  // since page load rather than sampling a window after the fact.
  const [css, imperative] = await Promise.all([
    extractCssAnimations(page),
    collectMotion(page),
  ]);

  const movers = new Set(scroll.flatMap((stop) => stop.entries.map((e) => e.selector)));
  const data = {
    generatedAt: new Date().toISOString(),
    sources: {
      resolved: { count: resolved.length, fidelity: 'authoritative', error: resolvedError },
      running: { count: css.running.length, fidelity: 'authoritative' },
      imperative: {
        count: imperative.tracks.length,
        fidelity: 'observed',
        sampledMs: imperative.elapsedMs,
        framesSeen: imperative.frameCount,
      },
      defined: { count: css.keyframes.length, fidelity: 'authoritative' },
      // An empty track with no sampling behind it means "nobody looked", which is
      // a different fact from "there is none". Without this field a --quick run
      // reads as a page with no scroll-linked motion.
      scroll: { count: movers.size, stops: scroll.length, fidelity: 'observed', sampled: scrollSampled },
    },
    truncated: imperative.truncated,
    resolved,
    running: css.running,
    imperative: imperative.tracks,
    defined: css.keyframes,
    scroll,
  };

  // Written by the caller, not here: the unreproducible findings are produced
  // after this pass runs and belong in the same artifact, so whoever assembles
  // the file owns it.
  if (writeMotion) await writeFile(join(outDir, 'motion.json'), JSON.stringify(data, null, 2));
  return data;
}

/** One-line summary for the console. */
export function summarizeMotion(data) {
  const s = data.sources;
  const bits = [
    `${s.defined.count} @keyframes`,
    `${s.running.count} running`,
    `${s.imperative.count} imperative`,
  ];
  if (s.resolved.count) bits.push(`${s.resolved.count} resolved`);
  if (s.scroll?.count) bits.push(`${s.scroll.count} scroll-linked`);
  // Said out loud because the console line is what a reader sees first, and a
  // missing count is otherwise indistinguishable from a page that has none.
  if (s.scroll && s.scroll.sampled === false) bits.push('scroll not sampled');
  if (data.truncated) bits.push('truncated');
  return `Motion: ${bits.join(', ')}`;
}

// canvas/WebGL output has no DOM or CSS to hand back. It is listed so it reads
// as a known limit rather than a gap in the capture, not as something a rebuild
// can use.
const VISUAL_ONLY_NOTE = 'Efek ini dirender di canvas/WebGL, tidak ada representasi DOM/CSS yang bisa diekstrak. '
  + 'Referensi ini hanya untuk dilihat manusia sebagai acuan visual, bukan kode yang bisa dipakai langsung.';

/** Build the manifest's view of the motion capture. */
export function describeMotion({ args, motion, canvasInfo, jsSourcemap, jsInferred }) {
  return {
    mode: args.sourcemap ? 'full' : (args.scroll || args.interactions || args.hover ? 'standard' : 'quick'),
    path: 'motion.json',
    sources: motion.sources,
    truncated: motion.truncated,
    jsSourcemap,
    jsInferred,
    visualOnly: canvasInfo.map((c) => ({ ...c, warning: VISUAL_ONLY_NOTE })),
  };
}
