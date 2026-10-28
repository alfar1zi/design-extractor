#!/usr/bin/env node
// validate-plugin.mjs - check .claude-plugin/*.json + commands/*.md + skills/<name>/SKILL.md.
// Pure validators: read files, report {level, file, message}, exit non-zero on errors.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const FORBIDDEN_PLUGIN_FIELDS = new Set([
  'hooks', // legacy; commands/ directory is the correct path
]);

const REQUIRED_MARKETPLACE_FIELDS = ['id', 'name', 'owner', 'plugins'];

async function readJson(path) {
  const txt = await readFile(path, 'utf8');
  return JSON.parse(txt);
}

function scalarValue(value) {
  const trimmed = value.trim();
  if (trimmed === '>' || trimmed === '|') return { block: trimmed };
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Read the small YAML subset the Agent Skills spec needs without accepting a
 * block scalar as the literal description `>` character. The old line parser
 * did exactly that: the shipped SKILL.md looked valid to a human but the
 * validator saw `description` as one byte and never enforced the 1024-byte
 * routing-key limit.
 */
export async function readFrontmatter(path) {
  const txt = await readFile(path, 'utf8');
  const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const fm = {};
  for (let i = 0; i < lines.length; i++) {
    const mm = lines[i].match(/^([a-zA-Z_-]+):(?:\s*(.*))?$/);
    if (!mm) continue;
    const key = mm[1];
    const parsed = scalarValue(mm[2] || '');
    if (parsed && typeof parsed === 'object' && parsed.block) {
      const folded = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) {
        i++;
        const line = lines[i];
        folded.push(line === '' ? '' : line.replace(/^\s+/, ''));
      }
      fm[key] = parsed.block === '>'
        ? folded.join(' ').replace(/\s+/g, ' ').trim()
        : folded.join('\n').trim();
    } else {
      fm[key] = parsed;
    }
  }
  return fm;
}

function validateSkillFrontmatter(path, fm, expectedName) {
  const issues = [];
  if (!fm) return [{ level: 'error', file: path, message: 'no frontmatter' }];
  if (!fm.name) issues.push({ level: 'error', file: path, message: 'missing frontmatter field: name' });
  else {
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(fm.name) || fm.name.includes('--') || fm.name.length > 64) {
      issues.push({ level: 'error', file: path, message: 'name must be 1-64 lowercase letters, numbers and single hyphens' });
    }
    if (expectedName && fm.name !== expectedName) {
      issues.push({ level: 'error', file: path, message: `name must match parent directory: ${expectedName}` });
    }
  }
  if (!fm.description) issues.push({ level: 'error', file: path, message: 'missing frontmatter field: description' });
  else if (fm.description.length > 1024) issues.push({ level: 'error', file: path, message: `description exceeds 1024 characters (${fm.description.length})` });
  if (fm.license && fm.license.length > 500) issues.push({ level: 'error', file: path, message: 'license exceeds 500 characters' });
  if (fm.compatibility && fm.compatibility.length > 500) issues.push({ level: 'error', file: path, message: 'compatibility exceeds 500 characters' });
  return issues;
}

export async function validatePluginJson(pluginDir) {
  const issues = [];
  const path = join(pluginDir, '.claude-plugin', 'plugin.json');
  let data;
  try { data = await readJson(path); }
  catch (e) { issues.push({ level: 'error', file: path, message: `cannot read or parse JSON: ${e.message}` }); return issues; }

  if (!data.name) issues.push({ level: 'error', file: path, message: 'missing required field: name' });
  if (!data.version) issues.push({ level: 'error', file: path, message: 'missing required field: version' });
  else if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(data.version))) {
    issues.push({ level: 'error', file: path, message: `version must be semver, got ${JSON.stringify(data.version)}` });
  }
  if (!data.description) issues.push({ level: 'warn', file: path, message: 'recommended field missing: description' });

  for (const key of Object.keys(data)) {
    if (FORBIDDEN_PLUGIN_FIELDS.has(key)) {
      issues.push({ level: 'error', file: path, message: `forbidden field: ${key}. Use commands/ directory instead.` });
    }
  }

  return issues;
}

export async function validateMarketplaceJson(pluginDir) {
  const issues = [];
  const path = join(pluginDir, '.claude-plugin', 'marketplace.json');
  let data;
  try { data = await readJson(path); }
  catch (e) { issues.push({ level: 'error', file: path, message: `cannot read or parse JSON: ${e.message}` }); return issues; }

  for (const field of REQUIRED_MARKETPLACE_FIELDS) {
    if (!(field in data)) issues.push({ level: 'error', file: path, message: `missing required field: ${field}` });
  }

  if (data.plugins && Array.isArray(data.plugins)) {
    for (const [i, p] of data.plugins.entries()) {
      if (!p.name) issues.push({ level: 'error', file: path, message: `plugins[${i}] missing name` });
      if (!p.description) issues.push({ level: 'warn', file: path, message: `plugins[${i}] missing description` });
    }
  }

  return issues;
}

export async function validateCommands(repoDir) {
  const issues = [];
  const dir = join(repoDir, 'commands');
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { issues.push({ level: 'warn', file: dir, message: 'commands/ directory missing or unreadable' }); return issues; }

  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const full = join(dir, e.name);
    const fm = await readFrontmatter(full);
    if (!fm) {
      issues.push({ level: 'error', file: full, message: 'no frontmatter (file must start with --- ... ---)' });
      continue;
    }
    if (!fm.description) issues.push({ level: 'error', file: full, message: 'missing frontmatter field: description' });

    // A command that shells out to a script path is only useful if the path ships.
    const body = await readFile(full, 'utf8');
    for (const m of body.matchAll(/^!\s*node\s+(\.\/[^\s"']+)/gm)) {
      const target = join(repoDir, m[1]);
      try { await readFile(target); }
      catch { issues.push({ level: 'error', file: full, message: `command runs ${m[1]}, which does not exist` }); }
    }
  }

  return issues;
}

export async function validateSkill(repoDir) {
  const issues = [];
  const root = join(repoDir, 'skills');
  let dirs;
  try { dirs = await readdir(root, { withFileTypes: true }); }
  catch { issues.push({ level: 'warn', file: root, message: 'skills/ directory missing or unreadable' }); return issues; }

  let checked = 0;
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const path = join(root, d.name, 'SKILL.md');
    let fm;
    try { fm = await readFrontmatter(path); }
    catch { continue; }
    checked++;
    issues.push(...validateSkillFrontmatter(path, fm, d.name));
  }
  if (checked === 0) issues.push({ level: 'error', file: root, message: 'no skills/<name>/SKILL.md found' });
  return issues;
}

/**
 * Whether the published tarball can actually install the plugin. The `files`
 * array is the only thing that decides what npm ships, and a manifest left out of
 * it produces a package whose plugin entry point is missing: `npm pack` succeeds,
 * `npm test` passes from the working tree, and the failure only appears for the
 * user who installed it.
 */
export async function validatePackaging(repoDir) {
  const issues = [];
  const path = join(repoDir, 'package.json');
  let pkg;
  try { pkg = await readJson(path); }
  catch { return issues; }

  const files = Array.isArray(pkg.files) ? pkg.files : null;
  if (!files) {
    issues.push({ level: 'warn', file: path, message: 'no files array: npm will ship every untracked file it finds' });
    return issues;
  }
  for (const required of ['.claude-plugin', 'commands', 'scripts', 'skills']) {
    if (!files.includes(required)) {
      issues.push({ level: 'error', file: path, message: `files[] must include ${required}: the published package needs it` });
    }
  }
  if (pkg.bin && typeof pkg.bin === 'object') {
    for (const [name, target] of Object.entries(pkg.bin)) {
      const rel = String(target).replace(/^\.\//, '');
      try { await readFile(join(repoDir, rel)); }
      catch { issues.push({ level: 'error', file: path, message: `bin ${name} points at ${target}, which does not exist` }); }
    }
  }
  return issues;
}

export async function validateAll(repoDir = process.cwd()) {
  const [plugin, marketplace, commands, skill, packaging] = await Promise.all([
    validatePluginJson(repoDir),
    validateMarketplaceJson(repoDir),
    validateCommands(repoDir),
    validateSkill(repoDir),
    validatePackaging(repoDir),
  ]);
  return [...plugin, ...marketplace, ...commands, ...skill, ...packaging];
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const issues = await validateAll();
  if (issues.length === 0) {
    process.stdout.write('OK: plugin manifests and skill metadata are valid\n');
    process.exit(0);
  }
  for (const i of issues) {
    process.stdout.write(`${i.level === 'error' ? 'error' : 'warn '}: ${i.file}\n  ${i.message}\n`);
  }
  const errors = issues.filter((i) => i.level === 'error').length;
  process.exit(errors > 0 ? 1 : 0);
}
