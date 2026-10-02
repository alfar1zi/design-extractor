// manifest.mjs - assemble manifest.json.
//
// Kept out of inspect.mjs so the orchestrator stays inside the AGENTS.md
// 400-line cap. The shape is a contract: every field here is read by the skill
// and by anything comparing one capture against another, so renaming a field is
// a breaking change and adding one is not.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function safeHost(url) {
  try { return new URL(url).host; } catch { return 'unknown'; }
}

/**
 * @param {object} input
 * @param {string} input.outDir
 * @param {object} input.args
 * @param {object} input.primary   the primary page probe result
 * @param {number} input.docHeight
 * @param {object[]} input.artifacts
 * @param {object} input.motionCapture
 * @param {object} input.capture
 * @param {object} input.store
 * @param {{blockedCount: () => number, entryUrl: () => string}} input.interceptor
 */
export async function writeManifest({
  outDir, args, primary, docHeight, artifacts, motionCapture, capture, store, interceptor,
  partials = [],
}) {
  const manifest = {
    url: args.url, host: safeHost(args.url), viewport: args.viewport,
    timeout: args.timeout, timestamp: new Date().toISOString(),
    settle: primary.settle,
    docHeight, artifactCount: artifacts.length, artifacts,
    videoPath: args.recordVideo ? join(outDir, 'videos', 'scroll.webm') : null,
    hoverVideoPath: args.recordHoverVideo ? join(outDir, 'videos', 'hover.webm') : null,
    capture: {
      captured: capture.entries.length, bytes: capture.bytes,
      missing: store.missing.length, redirects: store.redirects.length,
      blockedRedirects: interceptor.blockedCount(),
      treeDir: 'tree', entryPath: store.get(interceptor.entryUrl())?.rel || null,
    },
    motionCapture,
    // Passes that failed. Absent on a clean run, so a consumer can tell "nothing
    // went wrong" from "this field is not implemented yet", and never has to
    // guess whether an artifact it is reading is the whole story.
    ...(partials.length ? { partialFailures: partials } : {}),
  };
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}