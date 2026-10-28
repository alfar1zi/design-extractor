import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePluginJson, validateMarketplaceJson, validateCommands, validateSkill, validateAll, validatePackaging } from '../validate-plugin.mjs';

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

test('a folded block description is read as text, not as the > character', async () => {
  // The shipped SKILL.md writes `description: >` and continues on the next lines.
  // A line parser stored the single byte ">", which is truthy, so the field looked
  // present and its 1024-character limit was never enforced.
  const dir = await mkdtemp(join(tmpdir(), 'validate-plugin-'));
  try {
    const text = 'Stop copying pixels. Extract the source and the runtime behaviour.';
    await mkdir(join(dir, 'skills', 'design-extractor'), { recursive: true });
    await writeFile(join(dir, 'skills', 'design-extractor', 'SKILL.md'),
      `---\nname: design-extractor\ndescription: >\n  ${text}\n---\n\nbody\n`);
    const issues = await validateSkill(dir);
    assert.deepEqual(issues, [], 'a folded description is valid');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a description over the spec limit is an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'validate-plugin-'));
  try {
    await mkdir(join(dir, 'skills', 'design-extractor'), { recursive: true });
    await writeFile(join(dir, 'skills', 'design-extractor', 'SKILL.md'),
      `---\nname: design-extractor\ndescription: ${'x'.repeat(1025)}\n---\n\nbody\n`);
    const issues = await validateSkill(dir);
    assert.ok(issues.some((i) => i.message.includes('1024')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a name that does not match its directory is an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'validate-plugin-'));
  try {
    await mkdir(join(dir, 'skills', 'design-extractor'), { recursive: true });
    await writeFile(join(dir, 'skills', 'design-extractor', 'SKILL.md'), '---\nname: Other-Skill\ndescription: x\n---\n\nbody\n');
    const issues = await validateSkill(dir);
    assert.ok(issues.some((i) => i.message.includes('lowercase')));
    assert.ok(issues.some((i) => i.message.includes('parent directory')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a non-semver plugin version is an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'validate-plugin-'));
  try {
    await mkdir(join(dir, '.claude-plugin'), { recursive: true });
    await writeFile(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'x', version: 'v1', description: 'd' }));
    const issues = await validatePluginJson(dir);
    assert.ok(issues.some((i) => i.message.includes('semver')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a command that runs a script which does not exist is an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'validate-plugin-'));
  try {
    await mkdir(join(dir, 'commands'), { recursive: true });
    await writeFile(join(dir, 'commands', 'x.md'), '---\ndescription: d\n---\n\n!node ./scripts/gone.mjs "$ARGUMENTS"\n');
    const issues = await validateCommands(dir);
    assert.ok(issues.some((i) => i.message.includes('does not exist')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('packaging fails when files[] would not ship the plugin manifest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'validate-plugin-'));
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0', files: ['scripts', 'README.md'] }));
    const issues = await validatePackaging(dir);
    const msgs = issues.map((i) => i.message);
    assert.ok(msgs.some((m) => m.includes('.claude-plugin')), 'the manifest is the thing that was missing');
    assert.ok(msgs.some((m) => m.includes('commands')));
    assert.ok(!msgs.some((m) => m.includes('files[] must include scripts')), 'scripts is present');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('packaging reports a bin entry that points nowhere', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'validate-plugin-'));
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0', files: ['.claude-plugin', 'commands', 'scripts', 'skills'], bin: { x: './scripts/there.mjs' } }));
    const issues = await validatePackaging(dir);
    assert.ok(issues.some((i) => i.message.includes('bin x points at')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
