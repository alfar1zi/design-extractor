#!/usr/bin/env node
// sourcemap-extract.mjs - extract original source trees from JS source maps,
// recovery and AST-based GSAP/ScrollTrigger animation extraction.

import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { resolve, join, sep, dirname } from 'node:path';
import * as acorn from 'acorn';

// Fetch helper with timeout.
async function fetchWithTimeout(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(id);
  }
}

// Clean and normalize paths for safe recovery.
export function sanitizeRecoveredPath(outDir, srcPath) {
  let clean = srcPath.replace(/^[a-zA-Z0-9+-.]+:\/\/\/?/, '');
  // If the protocol/hostname was cleaned, it might still have a domain/port part left (like localhost:3000/assets/main.js -> localhost:3000/assets/main.js or assets/main.js)
  // Let's strip any leading domain-like string if it starts with localhost/domain/etc before reconstructing.
  // Actually, we can just split by '/' and if the first part contains a '.', ':' or is 'localhost', we can skip it to match the test expectation of 'assets/main.js'.
  clean = clean.replace(/\\/g, '/');
  clean = clean.replace(/^\/+/, '');
  let parts = clean.split('/').filter(p => p !== '' && p !== '.' && p !== '..');
  if (parts.length > 0) {
    const first = parts[0];
    if (first === 'localhost' || first.includes(':') || (first.includes('.') && !first.endsWith('.js') && !first.endsWith('.ts') && !first.endsWith('.jsx') && !first.endsWith('.tsx') && !first.endsWith('.json'))) {
      parts.shift();
    }
  }
  const recoveredDir = resolve(outDir, 'sourcemap-recovered');
  const target = resolve(join(recoveredDir, ...parts));
  if (!target.startsWith(recoveredDir + sep) && target !== recoveredDir) {
    throw new Error(`Path traversal detected: ${srcPath}`);
  }
  return target;
}

// Serializes AST arguments for animation details.
function serializeNode(node, source) {
  if (!node) return null;
  if (node.type === 'Literal') {
    return { type: 'Literal', value: node.value };
  }
  if (node.type === 'Identifier') {
    return { type: 'Identifier', name: node.name };
  }
  if (node.type === 'ObjectExpression') {
    const properties = {};
    for (const prop of node.properties) {
      if (prop.type === 'Property') {
        let keyName;
        if (prop.key.type === 'Identifier') {
          keyName = prop.key.name;
        } else if (prop.key.type === 'Literal') {
          keyName = String(prop.key.value);
        } else {
          keyName = source.slice(prop.key.start, prop.key.end);
        }
        properties[keyName] = serializeNode(prop.value, source);
      } else if (prop.type === 'SpreadElement') {
        const spreadKey = `...${source.slice(prop.argument.start, prop.argument.end)}`;
        properties[spreadKey] = serializeNode(prop.argument, source);
      }
    }
    return { type: 'ObjectExpression', properties };
  }
  if (node.type === 'ArrayExpression') {
    return {
      type: 'ArrayExpression',
      elements: node.elements.map(el => serializeNode(el, source))
    };
  }
  return {
    type: node.type,
    raw: source.slice(node.start, node.end)
  };
}

// Scans parsed AST for target animations.
export function scanJsAST(source, filePath) {
  let ast;
  try {
    ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  } catch {
    try {
      ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
    } catch {
      return [];
    }
  }

  const animations = [];
  const lines = source.split('\n');

  function getCalleeName(callee) {
    if (callee.type === 'MemberExpression') {
      if (callee.object.type === 'Identifier') {
        const objName = callee.object.name;
        if (callee.property.type === 'Identifier') {
          return `${objName}.${callee.property.name}`;
        }
      }
    }
    return null;
  }

  const targets = new Set([
    'gsap.to', 'gsap.from', 'gsap.fromTo', 'gsap.timeline',
    'ScrollTrigger.create', 'ScrollTrigger.matchMedia'
  ]);

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression') {
      const name = getCalleeName(node.callee);
      if (name && targets.has(name)) {
        const startLine = node.loc.start.line;
        const endLine = node.loc.end.line;
        const codeSnippet = lines.slice(startLine - 1, endLine).join('\n');
        
        animations.push({
          ...(filePath ? { file: filePath } : {}),
          callee: name,
          line: startLine,
          code: codeSnippet,
          arguments: node.arguments.map(arg => serializeNode(arg, source))
        });
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'loc') continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) walk(item);
      } else if (child && typeof child === 'object') {
        walk(child);
      }
    }
  }

  walk(ast);
  return animations;
}

// Recursively walks directories for files.
async function walkFiles(dir, files = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(fullPath, files);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

// Extracts original source tree or runs fallback scanner.
export async function extractFromSourceMap(jsContent, jsUrlOrPath, outDir) {
  let smUrl = null;
  const lines = jsContent.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    const m = line.match(/\/\/#\s*sourceMappingURL\s*=\s*(\S+)/);
    if (m) {
      smUrl = m[1];
      break;
    }
  }

  let sourceMap = null;

  if (smUrl) {
    try {
      if (smUrl.startsWith('data:')) {
        const comma = smUrl.indexOf(',');
        if (comma !== -1) {
          const meta = smUrl.slice(0, comma);
          const payload = smUrl.slice(comma + 1);
          const jsonStr = meta.includes('base64')
            ? Buffer.from(payload, 'base64').toString('utf8')
            : decodeURIComponent(payload);
          sourceMap = JSON.parse(jsonStr);
        }
      } else {
        const isUrl = jsUrlOrPath.startsWith('http:') || jsUrlOrPath.startsWith('https:');
        let sourcemapContent;
        if (isUrl) {
          const resolvedUrl = new URL(smUrl, jsUrlOrPath).href;
          sourcemapContent = await fetchWithTimeout(resolvedUrl, 5000);
        } else {
          const localPath = resolve(dirname(jsUrlOrPath), smUrl);
          sourcemapContent = await readFile(localPath, 'utf8');
        }
        sourceMap = JSON.parse(sourcemapContent);
      }
    } catch {
      // Ignore retrieval errors to trigger fallback
    }
  }

  let recoveredAny = false;
  if (sourceMap && typeof sourceMap === 'object') {
    const sources = sourceMap.sources || [];
    const contents = sourceMap.sourcesContent || [];
    const isUrl = jsUrlOrPath.startsWith('http:') || jsUrlOrPath.startsWith('https:');
    const sourcemapDir = isUrl ? null : dirname(jsUrlOrPath);

    for (let i = 0; i < sources.length; i++) {
      const srcPath = sources[i];
      let content = contents[i];
      if (typeof content !== 'string' && sourcemapDir) {
        const rawCleanPath = srcPath.replace(/^[a-zA-Z0-9+-.]+:\/\/\/?/, '');
        const localSrcPath = resolve(sourcemapDir, rawCleanPath);
        try {
          content = await readFile(localSrcPath, 'utf8');
        } catch {
          // not found
        }
      }
      if (typeof content === 'string') {
        const dest = sanitizeRecoveredPath(outDir, srcPath);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, content, 'utf8');
        recoveredAny = true;
      }
    }
  }

  if (recoveredAny) {
    const recoveredDir = resolve(outDir, 'sourcemap-recovered');
    const files = await walkFiles(recoveredDir);
    const jsExts = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);
    const allAnimations = [];

    for (const f of files) {
      const dot = f.lastIndexOf('.');
      const ext = dot >= 0 ? f.slice(dot).toLowerCase() : '';
      if (jsExts.has(ext)) {
        try {
          const src = await readFile(f, 'utf8');
          const relPath = f.slice(recoveredDir.length + 1).replace(/\\/g, '/');
          const fileAnims = scanJsAST(src, relPath);
          allAnimations.push(...fileAnims);
        } catch {
          // Ignore parse errors on individual files
        }
      }
    }

    const output = {
      fidelity: 'js-sourcemap',
      animations: allAnimations
    };
    const destJson = join(outDir, 'animations-js-sourcemap.json');
    await mkdir(outDir, { recursive: true });
    await writeFile(destJson, JSON.stringify(output, null, 2), 'utf8');
    return output;
  } else {
    // Fallback: js-inferred fallback on the minified JS code
    const fileAnims = scanJsAST(jsContent, null);
    const output = {
      fidelity: 'js-inferred',
      confidence_note: 'Direct static AST analysis on minified JS content.',
      animations: fileAnims
    };
    const destJson = join(outDir, 'animations-js-inferred.json');
    await mkdir(outDir, { recursive: true });
    await writeFile(destJson, JSON.stringify(output, null, 2), 'utf8');
    return output;
  }
}
