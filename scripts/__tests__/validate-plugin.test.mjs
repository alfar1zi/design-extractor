import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePluginJson, validateMarketplaceJson, validateCommands, validateSkill, validateAll } from '../validate-plugin.mjs';

async function buildFixture(root) {
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'design-extractor', version: '0.1.0', description: 'test' }));
  await writeFile(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({ id: 'design-extractor', name: 'design-extractor', owner: { name: 'alfar1zi' }, plugins: [{ name: 'design-extractor', description: 'test' }] }));
  await mkdir(join(root, 'commands'), { recursive: true });
  await writeFile(join(root, 'commands', 'design-extractor.md'), '---\ndescription: test\nargument-hint: url\n---\n\nbody\n');
  await mkdir(join(root, 'skills', 'design-extractor'), { recursive: true });
  await writeFile(join(root, 'skills', 'design-extractor', 'SKILL.md'), '---\nname: design-extractor\ndescription: test\n---\n\nbody\n');
}

test('validateAll passes on clean fixture', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'validate-plugin-'));
  try {
    await buildFixture(dir);
    const issues = await validateAll(dir);
    assert.equal(issues.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('validatePluginJson flags forbidden hooks field', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'validate-plugin-'));
  try {
    await mkdir(join(dir, '.claude-plugin'), { recursive: true });
    await writeFile(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'test', version: '1.0.0', hooks: { on_mention: 'x' } }));
    const issues = await validatePluginJson(dir);
    assert.ok(issues.some((i) => i.message.includes('forbidden field') && i.message.includes('hooks')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('validatePluginJson flags missing name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'validate-plugin-'));
  try {
    await mkdir(join(dir, '.claude-plugin'), { recursive: true });
    await writeFile(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '1.0.0' }));
    const issues = await validatePluginJson(dir);
    assert.ok(issues.some((i) => i.message.includes('missing required field: name')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('validateMarketplaceJson flags missing required fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'validate-plugin-'));
  try {
    await mkdir(join(dir, '.claude-plugin'), { recursive: true });
    await writeFile(join(dir, '.claude-plugin', 'marketplace.json'), '{}');
    const issues = await validateMarketplaceJson(dir);
    const msgs = issues.map((i) => i.message);
    assert.ok(msgs.some((m) => m.includes('id')));
    assert.ok(msgs.some((m) => m.includes('plugins')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('validateCommands flags missing description', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'validate-plugin-'));
  try {
    await mkdir(join(dir, 'commands'), { recursive: true });
    await writeFile(join(dir, 'commands', 'bad.md'), '---\nargument-hint: x\n---\n\nbody\n');
    const issues = await validateCommands(dir);
    assert.ok(issues.some((i) => i.message.includes('description')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('validateSkill flags missing name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'validate-plugin-'));
  try {
    await mkdir(join(dir, 'skills', 'design-extractor'), { recursive: true });
    await writeFile(join(dir, 'skills', 'design-extractor', 'SKILL.md'), '---\ndescription: x\n---\n\nbody\n');
    const issues = await validateSkill(dir);
    assert.ok(issues.some((i) => i.message.includes('missing frontmatter field: name')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
