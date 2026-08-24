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

async function readFrontmatter(path) {
  const txt = await readFile(path, 'utf8');
  const m = txt.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (!mm) continue;
    fm[mm[1]] = mm[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return fm;
}

export async function validatePluginJson(pluginDir) {
  const issues = [];
  const path = join(pluginDir, '.claude-plugin', 'plugin.json');
  let data;
  try { data = await readJson(path); }
  catch (e) { issues.push({ level: 'error', file: path, message: `cannot read or parse JSON: ${e.message}` }); return issues; }

  if (!data.name) issues.push({ level: 'error', file: path, message: 'missing required field: name' });
  if (!data.version) issues.push({ level: 'error', file: path, message: 'missing required field: version' });
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
  }

  return issues;
}

export async function validateSkill(repoDir) {
  const issues = [];
  const path = join(repoDir, 'skills', 'design-extractor', 'SKILL.md');
  const fm = await readFrontmatter(path);
  if (!fm) { issues.push({ level: 'error', file: path, message: 'no frontmatter' }); return issues; }
  if (!fm.name) issues.push({ level: 'error', file: path, message: 'missing frontmatter field: name' });
  if (!fm.description) issues.push({ level: 'error', file: path, message: 'missing frontmatter field: description' });
  return issues;
}

export async function validateAll(repoDir = process.cwd()) {
  const [plugin, marketplace, commands, skill] = await Promise.all([
    validatePluginJson(repoDir),
    validateMarketplaceJson(repoDir),
    validateCommands(repoDir),
    validateSkill(repoDir),
  ]);
  return [...plugin, ...marketplace, ...commands, ...skill];
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
