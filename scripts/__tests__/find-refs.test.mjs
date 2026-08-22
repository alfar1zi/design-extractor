import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, parseDuckDuckGoHTML, parseBraveJSON, pickBackend } from '../find-refs.mjs';

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
  assert.deepEqual(parseDuckDuckGoHTML(''), []);
  assert.deepEqual(parseDuckDuckGoHTML(null), []);
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
