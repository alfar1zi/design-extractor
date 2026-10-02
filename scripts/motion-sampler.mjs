// motion-sampler.mjs - observe motion that no browser devtools panel exposes.
//
// Two sources, because neither alone is enough:
//   - Web Animations / CSS transitions, via document.getAnimations();
//   - imperative animation (GSAP, anime.js, Motion, Lenis, AOS), which never
//     registers a WAAPI animation at all and only shows up as inline-style churn.
//
// The imperative source is a MutationObserver filtered to the `style` attribute,
// sampled on requestAnimationFrame. Reading getComputedStyle every frame instead
// would force a style recalc on every element on the page and make the thing we
// are measuring change what we measure.

/**
 * Installed in the page as a source string so it can go through page.evaluate
 * without a build step. Returns a handle the caller drives with `.stop()`.
 */
export const SAMPLER_SOURCE = `(${function installSampler(opts) {
  const { maxTracks = 400, maxStopsPerTrack = 24, maxFrames = 2400, minTextGrowth = 1, maxRevealChars = 256, scope = [] } = opts || {};
  const tracks = new Map();
  let frames = 0;
  let truncated = false;
  let rafId = null;
  let pending = new Set();
  // Per-element text-growth state. An element is only promoted to a track once
  // it has proven it is revealing rather than merely loading.
  const candidates = new Map();
  let running = false;

  const CSS_PROPS = [
    'transform', 'opacity', 'translate', 'rotate', 'scale', 'filter', 'backdrop-filter',
    'clip-path', 'width', 'height', 'top', 'left', 'right', 'bottom', 'margin',
    'padding', 'background-color', 'color', 'box-shadow', 'border-radius', 'visibility',
  ];

  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) return '#' + CSS.escape(el.id);
    const tag = el.tagName.toLowerCase();
    const cls = el.classList && el.classList.length
      ? '.' + Array.prototype.slice.call(el.classList).map((c) => CSS.escape(c)).join('.')
      : '';
    return tag + cls;
  }

  function snapshot(el) {
    const inline = el.style;
    const out = {};
    for (const p of CSS_PROPS) {
      const v = inline.getPropertyValue(p);
      if (v) out[p] = v.trim();
    }
    return out;
  }

  // With --target set, a track is only worth recording if the element is inside
  // one of the matched subtrees. The roots resolve lazily — the DOM does not
  // exist yet at install time — and are rebuilt once per frame, so a target
  // that mounts late joins the scope instead of being locked out by a cache
  // taken before it appeared.
  let scopeRoots = null;
  function inScope(el) {
    if (!scope.length) return true;
    if (!scopeRoots) {
      scopeRoots = [];
      for (const sel of scope) {
        try { scopeRoots.push(...document.querySelectorAll(sel)); } catch { /* not a valid selector */ }
      }
    }
    for (const root of scopeRoots) if (root === el || root.contains(el)) return true;
    return false;
  }

  function trackFor(el) {
    const selector = selectorFor(el);
    if (!selector || !inScope(el)) return null;
    let t = tracks.get(selector);
    if (!t) {
      if (tracks.size >= maxTracks) { truncated = true; return null; }
      t = { selector, tag: el.tagName.toLowerCase(), frames: 0, stops: [], last: null };
      tracks.set(selector, t);
    }
    return t;
  }

  function push(t, kind, stop) {
    t.frames++;
    if (t.stops.length < maxStopsPerTrack) {
      t.stops.push({ t: frames, kind, ...stop });
    } else {
      truncated = true;
    }
  }

  // An element that changes its inline transform/opacity. This is the GSAP and
  // anime.js path, and it is the only one a transform-only signature can see.
  function record(el) {
    const t = trackFor(el);
    if (!t) return;
    const style = snapshot(el);
    const computed = getComputedStyle(el);
    const transform = style.transform || computed.transform;
    const opacity = style.opacity || computed.opacity;
    const signature = transform + '|' + opacity;
    if (signature === t.last) return;
    // Where the element started. A replayer needs this stop to have something to
    // animate away from, but it is not itself motion, so it is labelled apart
    // and never makes a track read as a style tween on its own.
    const kind = t.last === null ? 'baseline' : 'style';
    t.last = signature;
    push(t, kind, { inlineStyle: style, transform, opacity });
  }

  // A typing or text-reveal animation appends characters, so nothing about the
  // element's transform or opacity ever changes and the style signature above
  // collapses every appended character into one entry that is then filtered out
  // as noise. The thing that moved is the text.
  //
  // The owner of revealed text is the element the mutation named, not an
  // ancestor of it: a childList record's target is the direct parent of the
  // changed nodes, and a characterData record's target is the text node whose
  // parent owns it. So no ancestor filter is needed to keep the tree from
  // reporting the same reveal once per level.
  //
  // Requiring the element to have grown its own childNodes looks like a
  // stricter version of that test, but a reveal appends characters *deeper
  // down*: tailwindcss.com types ` p-7` into a <code> inside a <code> inside a
  // <span class="line"> whose own childNodes never move. Measured on the live
  // page, the code line's text grows 331 -> 459 chars across six mutations
  // while its childNodes sit at 14 throughout. That condition rejected every
  // text animation this sampler exists to capture.
  //
  // A reveal fills one line of copy. A page streaming itself in also grows
  // text, and it grows it in exactly the same shape — a container's
  // textContent climbing as more of the document lands in it. The two are told
  // apart by size alone. Measured across three sites: every real reveal
  // appends 4-51 characters into an element ending under 60 characters, while
  // the containers that stream themselves in end at 3.6KB, 7.1KB and 149KB.
  // A bound in the middle of that gap keeps the reveals and drops the pages.
  function recordText(el) {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    let c = candidates.get(el);
    if (!c) {
      candidates.set(el, c = { len: text.length, started: false, dropped: false, buf: [text] });
      return;
    }
    // The bound is decided once, on the first growth, and an element that blew
    // past it is never reconsidered: a page streaming itself in only grows.
    if (c.dropped) return;
    const grewBy = text.length - c.len;
    c.len = text.length;
    if (grewBy <= 0) return;
    if (text.length > maxRevealChars || grewBy > maxRevealChars) { c.dropped = true; return; }
    const t = trackFor(el);
    if (!t) return;
    if (c.started) {
      push(t, 'content', { text, length: text.length });
      return;
    }
    c.buf.push(text);
    if (c.buf.length < minTextGrowth + 1) return;
    c.started = true;
    for (const b of c.buf) push(t, 'content', { text: b, length: b.length });
    c.buf.length = 0;
  }

  function tick() {
    if (!running) return;
    frames++;
    // Rebuilt here rather than per record: one querySelectorAll sweep per frame
    // instead of one per mutated element, and still fresh enough that a subtree
    // mounted this frame is in scope by the time its own mutations are read.
    scopeRoots = null;
    if (frames > maxFrames) { truncated = true; running = false; return; }
    for (const el of pending) record(el);
    pending = new Set();
    rafId = requestAnimationFrame(tick);
  }

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      const el = r.target;
      if (r.type === 'attributes') {
        // The imperative libraries that matter all write inline styles.
        if (el.nodeType === 1 && r.attributeName === 'style') pending.add(el);
        continue;
      }
      if (r.type === 'childList') {
        if (el.nodeType !== 1) continue;
        // Streaming a document in appends script payloads to <body>, and a
        // server-rendered page does the same as it hydrates. Measured on
        // tailwindcss.com, 19 such records grew <body> by 400-460KB within
        // 400ms of each other — the page arriving, not a reveal. Reporting them
        // would bury the handful of records that are real.
        if (el === document.body || el === document.documentElement) continue;
        let content = false;
        for (const n of r.addedNodes) {
          if (n.nodeType !== 1) { content = true; continue; }
          if (/^(SCRIPT|STYLE|LINK|TEMPLATE)$/.test(n.tagName)) continue;
          pending.add(n);
          content = true;
        }
        // The element whose rendered content actually changed: a typing
        // animation appends into a container that never touches its own style.
        // Read here, not on the next frame: a Set of pending elements collapses
        // every mutation of one element within a frame into a single read, so a
        // frame that caught two keystrokes reported one stop instead of two and
        // the typed text came back with holes in it. The longer the frame — which
        // is what a loaded machine does — the more was lost.
        if (content) recordText(el);
        continue;
      }
      // A text node rewritten in place. Its parent's text is what changed, and
      // characterData was not observed at all before, so a typewriter that edits
      // one text node rather than appending spans was invisible to this sampler.
      if (r.type === 'characterData' && el.parentElement) recordText(el.parentElement);
    }
    if (!running && pending.size) {
      running = true;
      rafId = requestAnimationFrame(tick);
    }
  });

  // `document`, not `document.documentElement`. When this runs as an init script
  // the document is still empty and documentElement is null, so observing it
  // throws and the sampler dies silently before the page has drawn anything —
  // which looks exactly like a page with no motion at all.
  observer.observe(document, {
    subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style'],
  });

  return {
    stop() {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
      return {
        tracks: Array.from(tracks.values()),
        frameCount: frames,
        truncated,
      };
    },
  };
}})`;

/**
 * Install the sampler so it is already running before the page's own scripts.
 *
 * This has to happen before `goto`, not after. An animation that finishes during
 * load — a typing effect that types out a line, a counter that settles at its
 * target, an intro that fades in over 300ms — is over before a sampler
 * installed after `waitForSettle` ever sees the page, and it is simply gone from
 * the capture with no way to know it was ever there.
 *
 * @param {import('playwright').Page} page
 * @param {{maxTracks?: number, scope?: string[]}} [options] `scope` holds the
 *   --target selectors; when given, only elements inside one are tracked.
 */
export async function installStyleSampler(page, { maxTracks = 400, scope = [] } = {}) {
  // A string expression gets no argument binding in Playwright, so the options go
  // in as JSON rather than as a second parameter.
  await page.addInitScript(`window.__deSampler = ${SAMPLER_SOURCE}(${JSON.stringify({ maxTracks, scope })})`);
}

/**
 * Stop the sampler and return everything it saw since page load.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{tracks: Array, frameCount: number, truncated: boolean, elapsedMs: number}>}
 */
export async function collectMotion(page) {
  const raw = await page.evaluate('window.__deSampler ? window.__deSampler.stop() : null').catch(() => null);
  const window_ = await page.evaluate('window.__deSampler ? performance.now() : 0').catch(() => 0);
  await page.evaluate('delete window.__deSampler').catch(() => {});
  // The sampler now watches from page load rather than for a fixed window, so
  // the number that reaches the artifact is the one that was actually observed.
  return finalize(raw, { ms: Math.round(window_ || 0) });
}

/**
 * Collapse raw samples into replayable stops: drop frames where nothing moved, and
 * cap each track so one jittery element cannot fill the file.
 */
export function finalize(raw, { ms = 0, maxStopsPerTrack = 24 } = {}) {
  const frameCount = raw?.frameCount || 0;
  const tracks = (raw?.tracks || []).map((t) => {
    const moves = [];
    let previous = null;
    for (const s of t.stops) {
      // A text stop's identity is its text. A style stop's identity is what it
      // renders as, so the two kinds never collapse into one another.
      const signature = s.kind === 'content'
        ? `text:${s.text}`
        : JSON.stringify([s.transform, s.opacity, s.inlineStyle]);
      if (signature === previous) continue;
      previous = signature;
      moves.push({
        offset: frameCount > 0 ? Number((s.t / frameCount).toFixed(4)) : 0,
        frame: s.t,
        kind: s.kind,
        ...(s.kind === 'content'
          ? { text: s.text, length: s.length, source: 'text-mutation' }
          : { transform: s.transform, opacity: s.opacity, inlineStyle: s.inlineStyle, source: 'style-mutation' }),
      });
    }
    const kept = moves.length > maxStopsPerTrack ? subsample(moves, maxStopsPerTrack) : moves;
    const first = kept[0]?.offset ?? 0;
    return {
      selector: t.selector,
      tag: t.tag,
      driver: 'imperative',
      fidelity: 'observed',
      // 'style' is a transform/opacity tween, 'content' is a typing or text
      // reveal, 'mixed' is an element doing both. A consumer replaying this
      // needs to know which: one tweens an inline style, the other appends
      // characters on a timer.
      motion: kept.some((s) => s.kind === 'content')
        && kept.some((s) => s.kind === 'style') ? 'mixed'
        : kept.some((s) => s.kind === 'content') ? 'content' : 'style',
      observedFrames: t.frames,
      stops: kept.map((s) => ({ ...s, offset: Number((s.offset - first).toFixed(4)) })),
      truncated: t.stops.length > kept.length,
    };
  }).filter((t) => t.stops.length > 1);

  tracks.sort((a, b) => b.stops.length - a.stops.length || a.selector.localeCompare(b.selector));
  return { tracks, frameCount, truncated: !!raw?.truncated, elapsedMs: ms };
}

/** Keep the first and last stop, then spread the budget evenly across the rest. */
function subsample(stops, budget) {
  const middle = stops.slice(1, -1);
  const room = budget - 2;
  const out = [stops[0]];
  for (let i = 0; i < room; i++) out.push(middle[Math.floor((i * middle.length) / room)]);
  out.push(stops[stops.length - 1]);
  return out.filter(Boolean);
}
