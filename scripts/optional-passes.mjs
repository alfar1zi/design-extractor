// optional-passes.mjs - the passes that measure behaviour, and the rule for
// what happens when one of them cannot run.
//
// These three are separate from the capture itself because they each load the
// page again in a fresh tab. The capture is already on disk by the time they
// run, so a pass that times out on a heavy site must not cost the caller
// everything that was already captured. Each one reports into `partials`,
// which lands in manifest.json - a consumer can then tell "this page has no
// hover states" from "the hover pass never ran", which are different problems
// and need different responses.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { interactionPass, hoverPass } from './interaction-pass.mjs';
import { statesPass } from './states-pass.mjs';
import { sweepPass } from './sweep-pass.mjs';

/**
 * Build the failure-tolerant runner shared by every optional pass.
 *
 * One rule, one place: a pass that measures optional behaviour and cannot run
 * records why and returns null, rather than aborting a capture that already
 * holds the tree, the tokens and the DOM.
 *
 * @param {object[]} partials collector, mutated in place
 * @param {(m: string) => void} err
 */
export function createAttempt(partials, err) {
  return async function attempt(label, fn) {
    try { return await fn(); } catch (e) {
      const reason = e?.message?.split('\n')[0] || String(e);
      partials.push({ pass: label, error: reason });
      err(`${label} pass failed: ${reason} - continuing, the rest of the capture is unaffected`);
      return null;
    }
  };
}

/**
 * @param {object} input
 * @param {import('playwright').BrowserContext} input.context
 * @param {import('playwright').Browser} input.browser
 * @param {import('playwright').Page} input.page reused by the state pass, which
 *   only reads the page already in front of it
 * @param {string} input.outDir
 * @param {object} input.args
 * @param {string} input.screenshotDir
 * @param {(p: string) => Promise<{path: string, size: number}>} input.fileMeta
 * @param {(m: string) => void} input.dim
 * @param {(m: string) => void} input.err
 * @param {object[]} input.partials collector, mutated in place
 * @param {Function} input.attempt from createAttempt
 * @returns {Promise<{artifacts: object[], interactions: object[], hovers: object[]}>}
 */
export async function runOptionalPasses({
  context, page, browser, outDir, args, screenshotDir, fileMeta, dim, err, partials, attempt,
}) {
  const artifacts = [];

  let interactions = [];
  if (args.interactions) {
    interactions = await attempt('interactions',
      () => interactionPass(context, args.url, args.timeout, screenshotDir)) || [];
    await writeFile(join(outDir, 'interactions.json'), JSON.stringify(interactions, null, 2));
    artifacts.push(await fileMeta(join(outDir, 'interactions.json')));
    dim(`Interaction pass: ${interactions.length} clickables (${interactions.filter((i) => i.error).length} errored)`);
  }

  let hovers = [];
  if (args.hover) {
    hovers = await attempt('hover',
      () => hoverPass(context, args.url, args.timeout, screenshotDir)) || [];
    await writeFile(join(outDir, 'hover.json'), JSON.stringify(hovers, null, 2));
    artifacts.push(await fileMeta(join(outDir, 'hover.json')));
    dim(`Hover pass: ${hovers.length} hovers (${hovers.filter((h) => h.error).length} errored)`);
  }

  if (args.states) {
    const counts = await attempt('states', () => statesPass(page, outDir, { scope: args.targets }));
    // Only listed when it ran. An empty states.json would read as a page with
    // no interactive elements rather than a state pass that never finished.
    if (counts) {
      artifacts.push(await fileMeta(join(outDir, 'states.json')));
      dim(`State pass: ${counts.total} states, ${counts.verifiedTiming} measured, ${counts.declaredTiming} declared, ${counts.unverifiedTiming} unverified`);
    }
  }

  // Sweep reloads the page at two more widths, so it can time out like any other
  // pass. It belongs here rather than at the call site: run bare, a single sweep
  // timeout threw out of main() and skipped the manifest write, destroying every
  // artifact that sorts after it while the ones before it survived on disk.
  if (args.sweep) {
    const sweep = await attempt('sweep',
      () => sweepPass(browser, args.url, args.timeout, screenshotDir, { allowPrivate: !!args.allowPrivate }));
    if (sweep) {
      for (const s of sweep) artifacts.push(await fileMeta(s.file));
      dim(`Sweep pass: ${sweep.length} viewports`);
    }
  }

  return { artifacts, interactions, hovers };
}
