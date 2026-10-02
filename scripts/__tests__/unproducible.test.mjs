import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectUnproducible, REASONS } from '../unproducible.mjs';

test('a clean page reports nothing it could not reproduce', () => {
  const r = collectUnproducible();
  assert.equal(r.complete, true);
  assert.equal(r.count, 0);
  assert.deepEqual(r.items, []);
  assert.match(r.howToRead, /Nothing/);
});

test('a canvas surface is named, not silently dropped', () => {
  const r = collectUnproducible({ canvasInfo: [{ selector: '#c', width: 800, height: 600 }] });
  assert.equal(r.complete, false);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].reason, 'canvas');
  assert.equal(r.items[0].detail.selector, '#c');
  assert.equal(r.items[0].note, REASONS.canvas);
});

test('a cross-origin stylesheet is listed by href', () => {
  const r = collectUnproducible({ crossOriginSheets: ['https://cdn.example/x.css'] });
  assert.equal(r.items[0].reason, 'crossOriginStylesheet');
  assert.equal(r.items[0].detail.href, 'https://cdn.example/x.css');
});

test('truncated motion sampling is reported as a limit', () => {
  const r = collectUnproducible({ truncatedMotion: true });
  assert.equal(r.items[0].reason, 'truncatedMotion');
  assert.equal(r.note, undefined);
});

test('minified component names are counted, and the boundary is still real', () => {
  const r = collectUnproducible({ unnamedComponents: 37 });
  assert.equal(r.items[0].reason, 'unminifiedName');
  assert.equal(r.items[0].count, 37);
  assert.match(r.items[0].note, /boundary was still found/);
});

test('every catalogued reason is one the collector can actually emit', () => {
  // The catalog held `closedShadowRoot`, `videos`, `scrollBehaviour` and
  // `workerOnlyContent`, and nothing ever set them: no capture could carry
  // those reasons. A consumer reading the file's own list of reasons was being
  // promised findings the engine never looked for. Each entry is proven here by
  // feeding its trigger and seeing it come out, so a reason cannot be added to
  // the catalog without something producing it.
  const TRIGGERS = {
    canvas: { canvasInfo: [{ selector: '#c' }] },
    crossOriginStylesheet: { crossOriginSheets: ['https://cdn.example/x.css'] },
    truncatedMotion: { truncatedMotion: true },
    unminifiedName: { unnamedComponents: 3 },
  };

  assert.deepEqual(Object.keys(REASONS).sort(), Object.keys(TRIGGERS).sort(),
    'the catalog and the reachable set must be the same set');

  for (const [reason, input] of Object.entries(TRIGGERS)) {
    const r = collectUnproducible(input);
    assert.ok(r.items.some((i) => i.reason === reason),
      `${reason} is catalogued but nothing in collectUnproducible produces it`);
    const item = r.items.find((i) => i.reason === reason);
    assert.ok(item.note && item.note.length > 20, `${reason} must explain itself`);
  }
});

test('a page with nothing unreproducible is complete, and a blocked stylesheet is not', () => {
  // `complete` is the field the docs tell consumers to trust before promising
  // a 1:1 rebuild. A cross-origin stylesheet whose rules were never read is
  // exactly the case where it must be false.
  assert.equal(collectUnproducible().complete, true);
  const blocked = collectUnproducible({ crossOriginSheets: ['https://cdn.example/x.css'] });
  assert.equal(blocked.complete, false, 'a stylesheet the browser refused to expose was not reported');
  assert.deepEqual(blocked.items[0].detail, { href: 'https://cdn.example/x.css' });
});

test('an unknown reason cannot be smuggled in through the detail field', () => {
  const r = collectUnproducible({ canvasInfo: [{ selector: '#c', sneaky: 'reason' }] });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].reason, 'canvas', 'the reason comes from the detector, not the payload');
});