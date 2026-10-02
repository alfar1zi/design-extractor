// dom-probe.mjs - read-only probes that run inside the page.
// Kept apart from inspect.mjs so the browser-side serialisation has one home.

// Roles a browser assigns from markup alone, keyed by tag. These are not
// optional: a document with headings and no explicit `role` attributes is the
// normal case, and dropping those nodes leaves the tree describing the page's
// buttons and nothing about its structure.
const TAG_ROLES = {
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
  nav: 'navigation', header: 'banner', footer: 'contentinfo', aside: 'complementary',
  li: 'listitem', textarea: 'textbox', search: 'search', fieldset: 'group',
};

// Tags whose name is already their role.
const SELF_ROLED = new Set(['button', 'main', 'form', 'article', 'img', 'list', 'option']);

// `<input>` is one tag with a dozen roles, chosen entirely by `type`.
const INPUT_ROLES = {
  checkbox: 'checkbox', radio: 'radio', range: 'slider', search: 'searchbox',
  email: 'textbox', tel: 'textbox', url: 'textbox', text: 'textbox', password: 'textbox',
  number: 'spinbutton', button: 'button', submit: 'button', reset: 'button', image: 'button',
};

/** Accessibility tree built by a DOM walk; page.accessibility was removed in Playwright 1.47+. */
export function probeA11y(page) {
  // Playwright passes a single argument, so the tables travel as one object.
  const tables = { tagRoles: TAG_ROLES, selfRoled: [...SELF_ROLED], inputRoles: INPUT_ROLES };
  return page.evaluate(({ tagRoles, selfRoled, inputRoles }) => {
    function implicitRole(el, tag) {
      if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
      if (tag === 'input') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        return inputRoles[t] ?? null;
      }
      return tagRoles[tag] ?? (selfRoled.includes(tag) ? tag : null);
    }
    function walk(el, depth) {
      if (depth > 8 || !el) return null;
      const tag = el.tagName.toLowerCase();
      // An explicit role always wins, including an invalid one: reporting what
      // the author actually wrote is this probe's job, not correcting them.
      const role = el.getAttribute('role') || implicitRole(el, tag);
      const name = (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || (el.textContent || '').trim().slice(0, 80)).trim();
      const children = [];
      for (const c of el.children) { const n = walk(c, depth + 1); if (n) children.push(n); }
      if (!role && !children.length) return null;
      return { role, name, tag, children };
    }
    return walk(document.documentElement, 0);
  }, tables);
}

/**
 * Wait until the page stops changing, instead of a fixed sleep. A slow hydration must
 * not be truncated; a finished one must not be padded.
 *
 * DOM stability alone is not enough. On a server-rendered app `readyState` reaches
 * 'interactive' the moment the document parses, but the framework's own route chunks
 * are only requested once its module script runs - which can be after the node count
 * has held steady. Waiting on the DOM alone therefore ended the capture with a fully
 * stable-looking page and none of the chunks that page was about to ask for. `network`
 * is the capture store's `quietFor(ms)`, so this also waits for responses to stop.
 *
 * @param {import('playwright').Page} page
 * @param {{stableMs?: number, capMs?: number, pollMs?: number, network?: (ms: number) => boolean}} [opts]
 * @returns {Promise<{elapsedMs: number, polls: number, timedOut: boolean}>}
 */
export async function waitForSettle(page, { stableMs = 500, capMs = 30_000, pollMs = 100, network } = {}) {
  const started = Date.now();
  let stableSince = started;
  // Measured from here, not from whenever the store happened to be created: a
  // store that has already been quiet for minutes would satisfy the very first
  // poll, which is the case this whole check exists to catch.
  let quietSince = started;
  let previous = -1;
  let polls = 0;
  for (;;) {
    polls += 1;
    await page.waitForTimeout(pollMs);
    // The cap is checked after this, so without a timeout of its own a page whose
    // main thread is blocked never returns from evaluate and the loop never
    // reaches the cap at all. Playwright applies no default to page.evaluate.
    const [nodes, ready] = await page.evaluate(
      () => [document.getElementsByTagName('*').length, document.readyState],
      undefined,
      { timeout: Math.max(1000, capMs - (Date.now() - started)) },
    ).catch(() => [-1, 'loading']);
    if (network && !network(pollMs)) quietSince = Date.now();
    const elapsed = Date.now() - started;
    if (nodes !== previous) {
      previous = nodes;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= stableMs
      && Date.now() - quietSince >= stableMs
      && (ready === 'complete' || ready === 'interactive')) {
      return { elapsedMs: elapsed, polls, timedOut: false };
    }
    if (elapsed >= capMs) {
      return { elapsedMs: elapsed, polls, timedOut: true };
    }
  }
}
