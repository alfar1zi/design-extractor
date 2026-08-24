#!/usr/bin/env node
// find-refs.mjs - discover reference website candidates. Default backend: DuckDuckGo HTML
// (no key, zero config). Optional paid backend: Brave Search via BRAVE_API_KEY.

import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DDG_URL = 'https://html.duckduckgo.com/html/';
const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';
const USER_AGENT = 'Mozilla/5.0 (compatible; design-extractor/0.1; +https://github.com/alfar1zi/design-extractor)';
const SUMMARY_CAP = 220;

// ---- pure helpers (exported for tests) ----

export function parseArgs(argv) {
  const out = { prompt: null, count: 5, json: null, backend: 'auto', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--prompt': out.prompt = next(); break;
      case '--count': out.count = Number(next()); break;
      case '--json': out.json = next(); break;
      case '--backend': out.backend = next(); break;
      case '-h': case '--help': out.help = true; break;
      default: throw new Error(`unknown flag: ${a}`);
    }
  }
  if (out.help) return out;
  if (!out.prompt) throw new Error('--prompt is required');
  if (!Number.isInteger(out.count) || out.count <= 0 || out.count > 50) throw new Error('--count must be a positive integer up to 50');
  if (!['auto', 'duckduckgo', 'brave'].includes(out.backend)) throw new Error(`--backend must be one of: auto, duckduckgo, brave`);
  return out;
}

export function pickBackend(requested, env = process.env) {
  if (requested === 'brave') return 'brave';
  if (requested === 'duckduckgo') return 'duckduckgo';
  // auto: prefer brave when key present (more reliable), else duckduckgo
  return env.BRAVE_API_KEY ? 'brave' : 'duckduckgo';
}

// Decode HTML entities for the few we actually need in DDG snippets/titles.
const decodeEntities = (s) => s
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&nbsp;/g, ' ')
  .replace(/&#x27;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

// Strip all HTML tags but keep text. Greedy-safe enough for search result fragments.
const stripTags = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

const DDG_MARKERS = [
  /<form[^>]+action=["'][^"']*duckduckgo\.com/i,
  /<input[^>]+name=["']q["']/i,
  /class=["'][^"']*results?["']/i,
  /duckduckgo\.com/i,
];

// True when html looks like a DuckDuckGo results page (vs. a captcha / rate-limit / markup change).
// Short or non-string input is rejected outright.
export function hasDdgMarkers(html) {
  if (typeof html !== 'string' || html.length < 500) return false;
  return DDG_MARKERS.some((re) => re.test(html));
}

// Parse a DDG HTML results page. Throws:
//   - 'DuckDuckGo HTML markup changed; parser needs update...' when structural markers absent.
//   - 'No results for prompt.' when markers present but parser found zero entries.
export function parseDuckDuckGoHTML(html) {
  if (!hasDdgMarkers(html)) {
    throw new Error('DuckDuckGo HTML markup changed; parser needs update. Use --backend brave with BRAVE_API_KEY as fallback.');
  }
  const results = [];
  // Each DDG result block has a link `.result__a` with href, and a `.result__snippet`.
  // We grab the anchor + the nearest snippet following it.
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[\s\S]*?>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = decodeEntities(m[1]);
    const title = decodeEntities(stripTags(m[2]));
    const summary = decodeEntities(stripTags(m[3]));
    if (!url || !title) continue;
    // DDG wraps external links in a redirect: /l/?uddg=<encoded>
    const finalUrl = extractDdgTarget(url) || url;
    results.push({ title, url: finalUrl, summary });
    if (results.length >= 50) break;
  }
  if (results.length === 0) {
    throw new Error('No results for prompt.');
  }
  return results;
}

function extractDdgTarget(href) {
  try {
    const u = new URL(href, DDG_URL);
    const uddg = u.searchParams.get('uddg');
    if (uddg) return uddg;
  } catch { /* ignore */ }
  return null;
}

export function parseBraveJSON(json) {
  const data = typeof json === 'string' ? safeJSON(json) : json;
  if (!data || !Array.isArray(data.web?.results)) return [];
  return data.web.results
    .map((r) => ({ title: r.title || '', url: r.url || '', summary: r.description || '' }))
    .filter((r) => r.title && r.url);
}

function safeJSON(s) { try { return JSON.parse(s); } catch { return null; } }

function cap(s, n) { return s.length <= n ? s : s.slice(0, n - 1) + '\u2026'; }

// ---- backends ----

async function searchDuckDuckGo(prompt, count) {
  const body = new URLSearchParams({ q: prompt, kl: 'us-en' });
  const res = await fetch(DDG_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT, accept: 'text/html' },
    body,
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const html = await res.text();
  // parseDuckDuckGoHTML throws 'markup changed' or 'No results for prompt.'; both bubble up.
  const results = parseDuckDuckGoHTML(html);
  return results.slice(0, count);
}

async function searchBrave(prompt, count, apiKey) {
  const u = new URL(BRAVE_URL);
  u.searchParams.set('q', prompt);
  u.searchParams.set('count', String(count));
  const res = await fetch(u, { headers: { 'x-subscription-token': apiKey, accept: 'application/json', 'user-agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
  const data = await res.json();
  const results = parseBraveJSON(data);
  if (results.length === 0) throw new Error('Brave returned 0 results');
  return results.slice(0, count);
}

// ---- pretty printing ----
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const out = (msg) => process.stdout.write(`[find] ${msg}\n`);
const err = (msg) => process.stderr.write(`[find] ${wrap('31', msg)}\n`);
const info = (m) => out(wrap('36', m));
const dim  = (m) => out(wrap('90', m));
const ok   = (m) => out(wrap('32', m));
const head = (m) => out(wrap('33', m));

const HELP = `design-extractor-find -- find reference website candidates

Usage: design-extractor-find --prompt <TEXT> [options]

Options:
  --prompt <TEXT>    search query (required)
  --count N          number of results (default: 5, max: 50)
  --backend <NAME>   auto | duckduckgo | brave (default: auto)
  --json <FILE>      write results as JSON to file
  -h, --help         show this help

Backends:
  duckduckgo   zero-config, scrapes html.duckduckgo.com (rate-limited)
  brave        requires BRAVE_API_KEY env var
  auto         brave if BRAVE_API_KEY is set, else duckduckgo
`;

// ---- main ----
async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { err(e.message); process.exit(2); }
  if (args.help) { process.stdout.write(HELP); return; }

  const backend = pickBackend(args.backend);
  info(`Backend: ${backend}`);
  dim(`Prompt: ${args.prompt}`);

  let results;
  try {
    if (backend === 'brave') {
      const key = process.env.BRAVE_API_KEY;
      if (!key) throw new Error('BRAVE_API_KEY not set');
      results = await searchBrave(args.prompt, args.count, key);
    } else {
      results = await searchDuckDuckGo(args.prompt, args.count);
    }
  } catch (e) {
    err(e.message);
    if (backend === 'duckduckgo' && !e.message.includes('No results')) {
      dim('hint: set BRAVE_API_KEY and retry with --backend brave, or --backend auto');
    } else if (backend === 'brave' && !process.env.BRAVE_API_KEY) {
      dim('hint: BRAVE_API_KEY not set; --backend auto will fall back to duckduckgo');
    }
    process.exit(1);
  }

  ok(`Found ${results.length} reference(s)`);
  if (!args.json) {
    head(`\n=== REFERENCE CANDIDATES (${results.length}) ===`);
    results.forEach((r, i) => {
      head(`[${i + 1}] ${r.title}`);
      dim(`    ${r.url}`);
      out(`    ${cap(r.summary || '(no summary)', SUMMARY_CAP)}`);
    });
  }

  if (args.json) {
    await writeFile(args.json, JSON.stringify(results, null, 2), 'utf8');
    dim(`Saved: ${args.json}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { err(e.stack || e.message); process.exit(1); });
}
