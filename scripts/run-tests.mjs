#!/usr/bin/env node
// run-tests.mjs - cross-platform test runner so `npm test` works on Node 18-22.
// `node --test scripts/__tests__` does not glob-expand; this script discovers
// `*.test.mjs` and forwards the explicit file list to `node --test`.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Pure: return sorted basenames of `*.test.mjs` in `testsDir`.
export async function discoverTests(testsDir) {
  const names = await readdir(testsDir);
  return names.filter((name) => name.endsWith('.test.mjs')).sort();
}

// Pure: resolve each name to an absolute path under `testsDir`.
export function resolveTests(testsDir, names) {
  return names.map((name) => join(testsDir, name));
}

// Thin alias for the existing test suite that expects full paths.
export async function discoverTestFiles(testsDir) {
  return resolveTests(testsDir, await discoverTests(testsDir));
}

// Thin alias that spawns node --test and resolves with the exit code.
export function runNodeTest(files) {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit' });
    child.on('error', (e) => {
      console.error(`run-tests: spawn failed: ${e.message}`);
      resolveP(1);
    });
    child.on('close', (code) => resolveP(code ?? 1));
  });
}

function main() {
  const testsDir = join(process.cwd(), 'scripts', '__tests__');
  discoverTests(testsDir)
    .then((names) => {
      if (names.length === 0) {
        console.error('No test files found in', testsDir);
        process.exit(2);
      }
      const args = ['--test', ...resolveTests(testsDir, names)];
      const child = spawn(process.execPath, args, { stdio: 'inherit' });
      child.on('error', (e) => {
        console.error(`run-tests: spawn failed: ${e.message}`);
        process.exit(1);
      });
      child.on('close', (code) => process.exit(code ?? 1));
    })
    .catch((e) => {
      console.error(`run-tests: ${e.message}`);
      process.exit(2);
    });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
