// css-animation-extract.mjs - what the CSS engine itself is running.
//
// Two passes, because they answer different questions:
//   - document.getAnimations() says what is moving right now, keyframe by keyframe;
//   - a recursive walk of styleSheets says what is defined, including inside the
//     @media and @supports blocks the old flat walk never entered.
//
// Neither sees GSAP, anime.js or a requestAnimationFrame loop; motion-sampler.mjs
// covers those. Anything not observed by all three is genuinely not moving.

/**
 * Read CSS-native animation state out of a live page.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{running: Array, keyframes: Array, truncated: boolean}>}
 */
export async function extractCssAnimations(page) {
  return await page.evaluate(() => {
    const KEYFRAME_FIELDS = ['composite', 'offset', 'computedOffset', 'easing', 'effectingTiming'];

    /** A selector that resolves to exactly one element, or says that it could not. */
    function selectorFor(el) {
      if (!el || el.nodeType !== 1) return { selector: null, unique: false };
      const parts = [];
      for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 6; node = node.parentElement, depth++) {
        let part = node.tagName.toLowerCase();
        if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
        // classList, not className: on an SVG element className is an SVGAnimatedString.
        for (const c of node.classList) { part += `.${CSS.escape(c)}`; break; }
        parts.unshift(part);
        if (parts[0] !== '*' && document.querySelectorAll(parts.join(' > ')).length === 1) break;
      }
      const selector = parts.join(' > ');
      let unique = false;
      try { unique = document.querySelectorAll(selector).length === 1; } catch { unique = false; }
      return { selector, unique };
    }

    const running = [];
    for (const anim of document.getAnimations()) {
      const effect = anim.effect;
      if (!effect) continue;
      const { selector, unique } = selectorFor(effect.target);
      let timing = {};
      let frames = [];
      try { timing = effect.getTiming(); } catch { /* a timing-less effect is still a finding */ }
      try { frames = effect.getKeyframes(); } catch { /* scroll-driven effects may refuse */ }
      running.push({
        type: 'running-animation',
        animationName: anim.animationName || null,
        playState: anim.playState,
        currentTime: Number(anim.currentTime) || 0,
        duration: timing.duration ?? null,
        delay: timing.delay ?? null,
        iterations: timing.iterations ?? null,
        easing: timing.easing ?? null,
        direction: timing.direction ?? null,
        fill: timing.fill ?? null,
        target: { selector, unique },
        keyframes: frames.map((k) => {
          const out = { offset: k.computedOffset, easing: k.easing, composite: k.composite };
          // The named properties are the only ones a clone can act on.
          for (const p of Object.keys(k)) if (!KEYFRAME_FIELDS.includes(p)) out[p] = k[p];
          return out;
        }),
      });
    }

    // @keyframes can be nested anywhere, so the walk recurses into grouping rules.
    const keyframes = [];
    const seen = new Set();
    const walk = (rules, inside) => {
      for (const rule of rules) {
        if (rule.type === CSSRule.KEYFRAMES_RULE) {
          const id = `${inside}|${rule.name}`;
          if (seen.has(id)) continue;
          seen.add(id);
          keyframes.push({
            name: rule.name,
            inside,
            steps: Array.from(rule.cssRules, (k) => ({
              keyText: k.keyText,
              easing: k.easing,
              declarations: k.style ? k.style.cssText : '',
            })),
          });
          continue;
        }
        if (rule.cssRules) {
          const media = rule.conditionText || rule.media?.mediaText || null;
          walk(rule.cssRules, inside ? `${inside} > ${media || rule.constructor.name}` : (media || rule.constructor.name));
        }
      }
    };
    for (const sheet of document.styleSheets) {
      let rules;
      // A cross-origin stylesheet throws on access, not on the walk.
      try { rules = sheet.cssRules; } catch { continue; }
      if (rules) walk(rules, sheet.href ? new URL(sheet.href, location.href).href : 'inline');
    }

    return { running, keyframes, truncated: false };
  });
}
