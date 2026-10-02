/* Imperative motion.
 *
 * GSAP is not vendored here — the property under test is the MECHANISM every
 * major animation library uses: a rAF loop writing `style.transform` and
 * `style.opacity` on elements. That is invisible to document.getAnimations(),
 * to the DevTools Animations panel, and to any capture that reads the CSSOM,
 * and it is exactly what the MutationObserver sampler is built to see.
 *
 * Deliberately deterministic: the value written is a pure function of elapsed
 * time and of scrollY, so the original and its offline replica render the same
 * bytes at the same scroll position and the fidelity diff measures the capture,
 * not the clock.
 */
(function () {
  'use strict';

  var cards = document.querySelectorAll('#cards .card');
  var bandBg = document.querySelector('.band__bg');
  var BAND = document.getElementById('band');

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  /* A closed shadow root. The build plan assumed CDP's
   * DOM.getDocument({pierce:true}) crosses closed roots; that has never been
   * run, so it is measured here rather than asserted. */
  (function () {
    var host = document.getElementById('closed-host');
    if (!host) return;
    var root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<style>.pin{font:14px/1.4 system-ui;color:#64748b}</style>' +
      '<p class="pin">inside a closed shadow root</p>';
  })();

  function applyScroll() {
    if (!bandBg || !BAND) return;
    var top = BAND.offsetTop;
    var travel = Math.max(1, BAND.offsetHeight);
    var t = clamp01((window.scrollY - top) / travel);
    bandBg.style.transform = 'translateY(' + (lerp(0, 160, t)).toFixed(2) + 'px)';
    bandBg.style.opacity = lerp(0.18, 0.85, t).toFixed(3);
  }

  var start = null;
  var DURATION = 600;

  function step(now) {
    if (start === null) start = now;
    var t = clamp01((now - start) / DURATION);
    var eased = 1 - Math.pow(1 - t, 3);
    for (var i = 0; i < cards.length; i++) {
      cards[i].style.transform = 'translateY(' + lerp(28, 0, eased).toFixed(2) + 'px)';
      cards[i].style.opacity = lerp(0, 1, eased).toFixed(3);
    }
    if (t < 1) { window.requestAnimationFrame(step); return; }
    /* Settled end state, so a screenshot taken after the pass never depends on
     * when the timer happened to land. */
    for (var j = 0; j < cards.length; j++) {
      cards[j].style.transform = 'translateY(0px)';
      cards[j].style.opacity = '1';
    }
    window.__fixtureMotionSettled = true;
  }

  window.addEventListener('scroll', applyScroll, { passive: true });
  window.addEventListener('resize', applyScroll);
  applyScroll();
  window.requestAnimationFrame(step);
})();
