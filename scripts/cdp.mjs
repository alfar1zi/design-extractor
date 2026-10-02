// cdp.mjs - read the cascade and the animation source straight out of the engine.
//
// Two facts the DOM will not give you, both verified against the protocol:
//   - `Animation.animationStarted` carries the whole resolved animation: timing,
//     easing, fill, and the @keyframes the engine actually chose. No follow-up
//     call is needed, and it survives a minified or obfuscated bundle.
//   - `CSS.getMatchedStylesForNode` returns matching rules in ASCENDING
//     specificity order, so the last declaration of a property is the one that
//     wins. `active` is not populated, and `matchingIndexes` is `[null]` for a
//     non-composite rule, so neither can be used to decide what applied.

/**
 * Connect to the page's debugger and start collecting animations as they start.
 *
 * @param {import('playwright').Page} page
 */
export async function openCdp(page, { timeoutMs = 15_000, maxAnimations = 2000 } = {}) {
  const session = await page.context().newCDPSession(page);
  // Bounded: this array is only read by `animations()`, but the events arrive
  // for the life of the session, and a page looping an animation for the length
  // of a capture would otherwise grow it without limit.
  const started = [];
  session.on('Animation.animationStarted', (e) => {
    if (started.length < maxAnimations) started.push(e.animation);
  });

  await Promise.all([
    session.send('DOM.enable', undefined, { timeout: timeoutMs }),
    session.send('CSS.enable', undefined, { timeout: timeoutMs }),
    session.send('Animation.enable', undefined, { timeout: timeoutMs }),
  ]);

  return {
    session,
    // Chromium does not always answer, and a caller with no timeout of its own
    // would wait forever. Every caller already treats a send failure as a skip,
    // so a timeout resolves into that same path rather than hanging the run.
    send: (method, params) => session.send(method, params, { timeout: timeoutMs }),
    animations: () => started,
    close: () => session.detach().catch(() => {}),
  };
}

/** Every animation the engine has started since connect, fully resolved. */
export function animatedStylesFor(cdp) {
  return cdp.animations().map((a) => ({
    id: a.id,
    name: a.name || null,
    type: a.type,
    playState: a.playState,
    paused: a.pausedState === true,
    playbackRate: a.playbackRate,
    startTime: a.startTime,
    currentTime: a.currentTime,
    timing: a.source
      ? {
        duration: a.source.duration,
        delay: a.source.delay,
        endDelay: a.source.endDelay,
        iterations: a.source.iterations,
        direction: a.source.direction,
        fill: a.source.fill,
        easing: a.source.easing,
        iterationStart: a.source.iterationStart,
      }
      : null,
    keyframes: a.source?.keyframesRule?.keyframes || [],
    // The node the animation runs on, resolved lazily so a disconnected page
    // cannot break the whole capture.
    backendNodeId: a.source?.backendNodeId ?? null,
  }));
}

/**
 * Declarations that applied to the first node matching `selector`, in cascade
 * order, with the winner for each property named. Returns null when nothing
 * matches the selector at all.
 */
export async function matchedStylesFor(cdp, selector) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) return null;
  const { matchedCSSRules } = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });
  const rules = simplifyRules(matchedCSSRules || []);
  return { rules, winners: cascadeWinners(rules) };
}

/** Flatten the CDP rule list, dropping declarations the stylesheet disabled. */
export function simplifyRules(rules) {
  return rules.map((entry) => ({
    selector: entry.rule?.selectorList?.text ?? null,
    origin: entry.rule?.origin ?? null,
    styleSheetId: entry.rule?.style?.styleSheetId ?? null,
    declarations: (entry.rule?.style?.cssProperties || [])
      .filter((p) => p.disabled !== true)
      .map((p) => ({
        name: p.name,
        value: p.value,
        important: p.important === true,
      })),
  }));
}

/**
 * Which declaration won each property.
 *
 * Rules arrive in ascending specificity, so a later declaration of the same
 * property beats an earlier one. `!important` beats specificity regardless of
 * position, which is the whole reason a plain "last one wins" gives the wrong
 * answer on a page that uses important.
 *
 * @param {ReturnType<typeof simplifyRules>} rules
 * @returns {Record<string, {value: string, selector: string|null, important: boolean}>}
 */
export function cascadeWinners(rules) {
  const winners = new Map();
  rules.forEach((rule, ruleIndex) => {
    rule.declarations.forEach((decl, declIndex) => {
      const current = winners.get(decl.name);
      const beats = !current
        || (decl.important && !current.important)
        || (decl.important === current.important && (ruleIndex > current.ruleIndex
          || (ruleIndex === current.ruleIndex && declIndex > current.declIndex)));
      if (beats) winners.set(decl.name, { ...decl, selector: rule.selector, ruleIndex, declIndex });
    });
  });
  return Object.fromEntries(
    [...winners].map(([name, w]) => [name, { value: w.value, selector: w.selector, important: w.important }]),
  );
}
