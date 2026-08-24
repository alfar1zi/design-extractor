import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, parseDuckDuckGoHTML, parseBraveJSON, pickBackend, hasDdgMarkers } from '../find-refs.mjs';

test('parseArgs requires --prompt', () => {
  assert.throws(() => parseArgs([]), /--prompt is required/);
});

test('parseArgs reads all flags', () => {
  const a = parseArgs(['--prompt', 'designers', '--count', '8', '--backend', 'brave', '--json', '/tmp/x.json']);
  assert.equal(a.prompt, 'designers');
  assert.equal(a.count, 8);
  assert.equal(a.backend, 'brave');
  assert.equal(a.json, '/tmp/x.json');
});

test('parseArgs rejects non-integer count', () => {
  assert.throws(() => parseArgs(['--prompt', 'x', '--count', '0']), /--count/);
  assert.throws(() => parseArgs(['--prompt', 'x', '--count', '51']), /--count/);
  assert.throws(() => parseArgs(['--prompt', 'x', '--count', 'abc']), /--count/);
});

test('parseArgs rejects bad backend name', () => {
  assert.throws(() => parseArgs(['--prompt', 'x', '--backend', 'google']), /--backend/);
});

test('parseDuckDuckGoHTML parses a minimal fixture', () => {
  const html = `
    <html><body>
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fstripe.com%2F&amp;kl=">Stripe &mdash; Payments</a>
        <a class="result__snippet">Stripe is a financial technology company building economic infrastructure.</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://linear.app">Linear &amp; Issue Tracker</a>
        <a class="result__snippet">The issue tracking tool you will enjoy using.</a>
      </div>
    </body></html>`;
  const out = parseDuckDuckGoHTML(html);
  assert.equal(out.length, 2);
  assert.equal(out[0].url, 'https://stripe.com/');
  assert.match(out[0].title, /Stripe/);
  assert.match(out[0].summary, /financial technology/);
  assert.equal(out[1].url, 'https://linear.app');
  assert.match(out[1].title, /Linear/);
});

test('parseDuckDuckGoHTML returns [] on empty input', () => {
  // Marker check rejects empty / non-string / short input with a clear upstream error.
  assert.throws(() => parseDuckDuckGoHTML(''), /markup changed/);
  assert.throws(() => parseDuckDuckGoHTML(null), /markup changed/);
});

test('hasDdgMarkers detects DDG page structure', () => {
  // Fixtures must be >= 500 chars so the length gate passes; each is a realistic DDG page skeleton.
  const pad = 'x'.repeat(600);
  assert.equal(hasDdgMarkers(`<html><input name="q">${pad}</html>`), true);
  assert.equal(hasDdgMarkers(`<html>duckduckgo.com/html results ${pad}</html>`), true);
  assert.equal(hasDdgMarkers(`<html><form action="//duckduckgo.com/html/">${pad}</form></html>`), true);
  assert.equal(hasDdgMarkers(`<html><div class="results">${pad}</div></html>`), true);
  assert.equal(hasDdgMarkers(`<html>random text ${pad}</html>`), false);
  assert.equal(hasDdgMarkers(''), false);
  assert.equal(hasDdgMarkers(null), false);
});

test('parseDuckDuckGoHTML throws when DDG markers missing', () => {
  const html = '<html><body>Some unrelated page</body></html>';
  assert.throws(() => parseDuckDuckGoHTML(html), /markup changed/);
});

test('parseDuckDuckGoHTML throws "no results" when structure present but empty', () => {
  // Padded so the marker check (length >= 500) passes; structure is recognizable DDG.
  const filler = '<!-- padding to make the response look like a real DDG page so the marker check passes -->'.repeat(8);
  const html = `
    <html>
      <body>
        <form action="//duckduckgo.com/html/">
          <input name="q" type="text" />
        </form>
        <div class="results">
          ${filler}
        </div>
      </body>
    </html>
  `;
  try {
    const out = parseDuckDuckGoHTML(html);
    assert.deepEqual(out, []);
  } catch (e) {
    assert.match(e.message, /No results/);
    assert.doesNotMatch(e.message, /markup changed/);
  }
});

test('parseDuckDuckGoHTML rejects non-string input', () => {
  assert.throws(() => parseDuckDuckGoHTML(null), /markup changed/);
  assert.throws(() => parseDuckDuckGoHTML(''), /markup changed/);
  assert.throws(() => parseDuckDuckGoHTML(123), /markup changed/);
});

test('parseBraveJSON handles Brave response shape', () => {
  const data = {
    web: {
      results: [
        { title: 'Vercel', url: 'https://vercel.com', description: 'Frontend cloud platform.' },
        { title: 'Framer', url: 'https://framer.com', description: 'Design and publish sites.' },
        { title: 'NoUrl', url: '', description: 'should be dropped' },
      ],
    },
  };
  const out = parseBraveJSON(data);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'Vercel');
  assert.equal(out[1].summary, 'Design and publish sites.');
});

test('parseBraveJSON returns [] for missing web.results', () => {
  assert.deepEqual(parseBraveJSON({}), []);
  assert.deepEqual(parseBraveJSON({ web: {} }), []);
});

test('parseBraveJSON accepts JSON string', () => {
  const out = parseBraveJSON('{"web":{"results":[{"title":"A","url":"https://a.test","description":"d"}]}}');
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://a.test');
});

test('pickBackend auto with no key returns duckduckgo', () => {
  assert.equal(pickBackend('auto', {}), 'duckduckgo');
});

test('pickBackend auto with key returns brave', () => {
  assert.equal(pickBackend('auto', { BRAVE_API_KEY: 'x' }), 'brave');
});

test('pickBackend explicit choices ignore env', () => {
  assert.equal(pickBackend('brave', {}), 'brave');
  assert.equal(pickBackend('duckduckgo', { BRAVE_API_KEY: 'x' }), 'duckduckgo');
});
