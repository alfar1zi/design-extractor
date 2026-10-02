import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { motionPass, summarizeMotion } from '../motion-pass.mjs';
import { installStyleSampler } from '../motion-sampler.mjs';

/** Load a fixture with the sampler installed first, the way inspect.mjs does. */
async function load(browser, html) {
  const page = await browser.newPage();
  await installStyleSampler(page);
  await page.route('**/*', (r) => r.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://localhost/');
  return page;
}

const FIXTURE = `<!DOCTYPE html><html><head><style>
  @keyframes pulse { from { opacity: 1 } to { opacity: 0 } }
  @media (min-width: 1px) { @keyframes slide { to { transform: translateX(10px) } } }
  #css { animation: 5s linear pulse }
  #imp { width: 10px; height: 10px; background: teal }
</style></head><body><div id="css"></div><div id="imp"></div>
<script>
  // What a rAF loop does: write inline styles, register nothing.
  let t = 0;
  const spin = () => {
    t += 0.5;
    document.getElementById('imp').style.transform = 'translateX(' + t + 'px)';
    if (t < 12) requestAnimationFrame(spin);
  };
  spin();
</script></body></html>`;

const TYPING_FIXTURE = `<!DOCTYPE html><html><body><p id="type"></p><script>
  const t = document.getElementById('type');
  ['c','l','o','n','e'].forEach((c, i) => setTimeout(() => {
    const s = document.createElement('span');
    s.style.display = 'inline';
    s.textContent = c;
    t.appendChild(s);
  }, 25 * (i + 1)));
</script></body></html>`;

test('motion.json reports every source and its fidelity', async () => {
  const browser = await chromium.launch();
  const dir = await mkdtemp(join(tmpdir(), 'motion-'));
  try {
    const page = await load(browser, FIXTURE);
    await page.waitForTimeout(300);
    const data = await motionPass(page, dir);

    assert.equal(data.sources.defined.fidelity, 'authoritative');
    assert.equal(data.sources.imperative.fidelity, 'observed');
    assert.ok(data.sources.defined.count >= 2, 'both keyframes rules, including the one inside @media');
    // The sampler watches from page load now, so this is the window it actually
    // saw rather than the duration someone asked it to run for.
    assert.ok(data.sources.imperative.sampledMs > 0);

    const written = JSON.parse(await readFile(join(dir, 'motion.json'), 'utf8'));
    assert.equal(written.sources.defined.count, data.sources.defined.count);
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('imperative motion is caught even though it registers no CSS animation', async () => {
  const browser = await chromium.launch();
  const dir = await mkdtemp(join(tmpdir(), 'motion-'));
  try {
    const page = await load(browser, FIXTURE);
    await page.waitForTimeout(500);
    const data = await motionPass(page, dir);

    const track = data.imperative.find((t) => t.selector.includes('imp'));
    assert.ok(track, 'the rAF-driven element is missing from motion.json');
    assert.equal(track.driver, 'imperative');
    assert.equal(track.fidelity, 'observed', 'observed, not reconstructed from source');
    assert.ok(track.stops.length >= 2, 'a single sample is not a motion track');
    assert.ok(track.stops.every((s) => s.offset >= 0 && s.offset <= 1));
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a static page reports zero motion rather than inventing some', async () => {
  const browser = await chromium.launch();
  const dir = await mkdtemp(join(tmpdir(), 'motion-'));
  try {
    const page = await load(browser, '<!DOCTYPE html><html><body><div style="color:red">static</div></body></html>');
    await page.waitForTimeout(300);
    const data = await motionPass(page, dir);
    assert.equal(data.running.length, 0);
    assert.equal(data.imperative.length, 0);
    assert.equal(data.defined.length, 0);
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a typing animation reaches motion.json with the text it typed', async () => {
  // The end-to-end proof. A text reveal changes no inline style at all, so it is
  // invisible to a transform-only sampler, and it finishes during load, so it is
  // also invisible to a sampler installed afterwards. Either way the clone came
  // back with the typed characters simply missing.
  const browser = await chromium.launch();
  const dir = await mkdtemp(join(tmpdir(), 'motion-'));
  try {
    const page = await load(browser, TYPING_FIXTURE);
    await page.waitForTimeout(400);
    const data = await motionPass(page, dir);

    const track = data.imperative.find((t) => t.selector === '#type');
    assert.ok(track, 'the typing animation is missing from motion.json');
    assert.equal(track.motion, 'content');
    assert.deepEqual(
      track.stops.filter((s) => s.kind === 'content').map((s) => s.text),
      ['c', 'cl', 'clo', 'clon', 'clone'],
    );
    assert.equal(data.sources.imperative.count, 1, 'the page had exactly one piece of motion');
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the summary says so when the sampler hit its cap', () => {
  const s = summarizeMotion({
    sources: {
      defined: { count: 3 }, running: { count: 1 },
      imperative: { count: 0 }, resolved: { count: 0 }, scroll: { count: 2 },
    },
    truncated: true,
  });
  assert.match(s, /^Motion: /);
  assert.match(s, /truncated/);
  assert.match(s, /3 @keyframes/);
  assert.match(s, /2 scroll-linked/, 'what scrolling revealed is in the summary too');
});

test('a run that never scrolled says so, instead of reporting an empty track as an answer', () => {
  // --quick turns the scroll pass off, so there is no track to report. A count
  // of zero here is not a finding about the page.
  const unsampled = summarizeMotion({
    sources: {
      defined: { count: 0 }, running: { count: 0 }, imperative: { count: 12 },
      resolved: { count: 0 }, scroll: { count: 0, stops: 0, sampled: false },
    },
    truncated: false,
  });
  assert.match(unsampled, /scroll not sampled/);
  assert.doesNotMatch(unsampled, /0 scroll-linked/);
});

test('a run that scrolled and found nothing still claims it looked', () => {
  const looked = summarizeMotion({
    sources: {
      defined: { count: 0 }, running: { count: 0 }, imperative: { count: 12 },
      resolved: { count: 0 }, scroll: { count: 0, stops: 8, sampled: true },
    },
    truncated: false,
  });
  assert.doesNotMatch(looked, /not sampled/, 'sampling happened and came back empty; that is a result');
});

test('the artifact records whether the scroll track was taken at all', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const dir = await mkdtemp(join(tmpdir(), 'de-scrollflag-'));
  try {
    await page.setContent('<div id="a" style="background:red">hi</div>');
    const off = await motionPass(page, dir, { scroll: [], scrollSampled: false, writeMotion: false });
    assert.equal(off.sources.scroll.sampled, false);
    const on = await motionPass(page, dir, { scroll: [], scrollSampled: true, writeMotion: false });
    assert.equal(on.sources.scroll.sampled, true, 'both runs report zero movers; only the flag tells them apart');
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
    await page.close();
  }
});
