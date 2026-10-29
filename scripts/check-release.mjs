#!/usr/bin/env node
// check-release.mjs - one version, five files, and a tag that has to agree.
//
// A release is the moment the repository makes a claim about itself. The tag is
// what users pin, package.json is what npm publishes, and the plugin manifest is
// what a marketplace installs; when they disagree the tag points at a tree that
// is not the thing it names. This was already true once in this repository: the
// tag said 0.2.0 and three manifests still said 0.1.0.
//
// Run: node scripts/check-release.mjs v0.2.0
//      node scripts/check-release.mjs          (checks internal agreement only)

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every file that carries a version, and where inside it the version lives. */
export async function versionsIn(repo = REPO) {
  const read = async (p) => JSON.parse(await readFile(join(repo, p), 'utf8'));
  const pkg = await read('package.json');
  const lock = await read('package-lock.json');
  const plugin = await read('.claude-plugin/plugin.json');
  const market = await read('.claude-plugin/marketplace.json');
  const skill = await read('skill.json');
  return [
    ['package.json', pkg.version],
    ['package-lock.json', lock.packages?.['']?.version],
    ['.claude-plugin/plugin.json', plugin.version],
    ['.claude-plugin/marketplace.json', market.plugins?.[0]?.version],
    ['skill.json', skill.version],
  ];
}

/**
 * Problems with a set of `[file, version]` pairs and an optional tag.
 *
 * The tag is stripped of its leading `v` before comparison, because git tags are
 * conventionally prefixed and npm versions are not.
 */
export function checkVersions(pairs, tag) {
  const problems = [];
  const seen = new Map();
  for (const [file, version] of pairs) {
    if (!version) { problems.push(`${file} has no version`); continue; }
    // A malformed version is reported once, by this branch. Letting it fall
    // through to the comparison reported the same file twice: once for its
    // shape and once for disagreeing with the others.
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version))) {
      problems.push(`${file} version is not semver: ${JSON.stringify(version)}`);
      continue;
    }
    if (!seen.has(version)) seen.set(version, []);
    seen.get(version).push(file);
  }
  if (seen.size > 1) {
    const groups = [...seen.entries()].map(([v, files]) => `${v} (${files.join(', ')})`).join(' vs ');
    problems.push(`manifests disagree: ${groups}`);
  }
  if (tag) {
    const wanted = String(tag).replace(/^v/, '');
    if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(tag))) {
      problems.push(`tag ${JSON.stringify(tag)} is not vX.Y.Z`);
    } else if (seen.size === 1 && !seen.has(wanted)) {
      problems.push(`tag ${tag} names ${wanted}, manifests say ${[...seen.keys()][0]}`);
    }
  }
  return problems;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\/scripts\//, 'scripts/'))) {
  const tag = process.argv[2];
  const problems = checkVersions(await versionsIn(), tag);
  if (problems.length) {
    for (const p of problems) process.stdout.write(`error: ${p}\n`);
    process.exit(1);
  }
  process.stdout.write(`OK: every manifest agrees on ${(await versionsIn())[0][1]}${tag ? ` and matches ${tag}` : ''}\n`);
}
