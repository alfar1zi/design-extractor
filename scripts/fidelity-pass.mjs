// fidelity-pass.mjs - score a finished capture against a reference directory.
//
// This is the pass that makes "1:1" a measurement instead of a claim. Every
// other artifact describes what the extractor believed about a page; this one
// puts two sets of pixels side by side and counts the difference, then names
// the largest box where they disagree. A rebuild that got the structure right
// and the spacing wrong scores badly here, which is exactly the failure no
// amount of JSON inspection would have caught.
//
// Both directories must come from one Chromium at one viewport with
// deviceScaleFactor 1, because rendering varies by host OS and browser build.
// Comparing shots taken under different conditions produces a diff ratio that
// measures the environment, not the rebuild.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scoreFidelity } from './fidelity.mjs';

/**
 * @param {object} input
 * @param {object} input.args inspect args; needs `fidelity`, `viewport`
 * @param {string} input.outDir
 * @param {string} input.screenshotDir where this run just wrote its own shots
 * @param {object[]} input.unreproducibleItems per-element findings, mapped onto
 *   the viewports they landed in so a score can say what it could not measure
 * @param {(label: string, fn: () => Promise<any>) => Promise<any>} input.attempt
 * @param {(p: string) => Promise<{path: string, size: number}>} input.fileMeta
 * @param {(m: string) => void} input.dim
 */
export async function runFidelityPass({
  args, outDir, screenshotDir, unreproducibleItems, attempt, fileMeta, dim,
}) {
  // No viewports argument: the shot names come from whatever this run wrote, so
  // the reference directory is compared on its own terms instead of being held
  // to a naming convention this run never promised.
  const scored = await attempt('fidelity', () => scoreFidelity(args.fidelity, screenshotDir, {
    // Carried through so a low ratio is not read as "the rebuild matched" when
    // part of the original was a video nobody can rebuild from a capture.
    // Keyed by the viewport these were observed in, which is what
    // `scoreFidelity` looks them up by: it reads `unreproducible[name]` where
    // `name` is a screenshot stem. Keying them by selector instead meant the
    // lookup never matched, so every finding was silently dropped and every
    // `viewports[].unreproducible` came back empty — the field existed to stop
    // a low ratio reading as "matched" and it did nothing.
    unreproducible: (unreproducibleItems || []).length
      ? { viewport: unreproducibleItems.map((e) => ({ selector: e.selector, reason: e.reason })) }
      : {},
  }));
  if (!scored) return null;

  await writeFile(join(outDir, 'fidelity.json'), JSON.stringify(scored, null, 2));
  const artifact = await fileMeta(join(outDir, 'fidelity.json'));
  const w = scored.worst;
  dim(`Fidelity: ${scored.status} across ${scored.measured} viewport(s)`
    + (w ? `, worst ${w.viewport} at ${(w.diffRatio * 100).toFixed(3)}% of pixels` : ''));
  if (scored.status === 'not-measured') {
    dim('  nothing was compared - the reference directory holds no matching screenshots');
  }
  return artifact;
}
