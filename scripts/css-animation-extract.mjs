import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Extract animations from the live page.
// Returns an array of css-native animation descriptors.
export async function extractCssAnimations(page) {
  return await page.evaluate(() => {
    const results = [];

    // 1. Traverse document.getAnimations() for active animations
    // (Note: getAnimations() does not see requestAnimationFrame/GSAP by default)
    try {
      const activeAnims = document.getAnimations();
      for (const anim of activeAnims) {
        if (!anim.effect) continue;
        const target = anim.effect.target;
        if (!target) continue;
        
        // Build selector path for target
        let selector = '';
        try {
          selector = target.id ? `#${target.id}` : `${target.tagName.toLowerCase()}${target.className ? '.' + [...target.classList].join('.') : ''}`;
        } catch { selector = 'unknown'; }

        let keyframes = [];
        try { keyframes = anim.effect.getKeyframes(); } catch { /* ignore */ }

        let timing = {};
        try { timing = anim.effect.getTiming(); } catch { /* ignore */ }

        results.push({
          fidelity: 'css-native',
          type: 'active-animation',
          selector,
          animationName: anim.animationName || null,
          playState: anim.playState,
          duration: timing.duration,
          delay: timing.delay,
          iterations: timing.iterations,
          easing: timing.easing,
          keyframes: keyframes.map(k => ({
            offset: k.offset,
            computedOffset: k.computedOffset,
            easing: k.easing,
            ...Object.fromEntries(Object.entries(k).filter(([key]) => !['offset', 'computedOffset', 'easing'].includes(key)))
          }))
        });
      }
    } catch (e) {
      // getAnimations might fail on some elements
    }

    // 2. Cross-check document.styleSheets for CSSKeyframesRule
    try {
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules || sheet.rules; } catch { continue; } // ignore cross-origin stylesheet security blocks
        if (!rules) continue;
        for (const rule of rules) {
          if (rule.type === CSSRule.KEYFRAMES_RULE || rule.tagName === 'keyframes') {
            const keyframesRule = rule;
            const steps = [];
            for (const keyframe of keyframesRule.cssRules) {
              steps.push({
                keyText: keyframe.keyText,
                cssText: keyframe.style.cssText
              });
            }
            results.push({
              fidelity: 'css-native',
              type: 'keyframes-rule',
              name: keyframesRule.name,
              steps
            });
          }
        }
      }
    } catch (e) {
      // styleSheets cross-check failed
    }

    return results;
  });
}

// Writes extracted animations to animations-css.json
export async function saveCssAnimations(page, outDir) {
  const data = await extractCssAnimations(page);
  const dest = join(outDir, 'animations-css.json');
  await writeFile(dest, JSON.stringify(data, null, 2));
  return { path: dest, count: data.length };
}
