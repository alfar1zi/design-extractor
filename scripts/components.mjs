// components.mjs - find the components on a page, and say how you found them.
//
// The distinction the output depends on:
//
//   authoritative  The framework itself says this node is a component instance.
//                   React's fiber tree, Vue's vnode tree, an Svelte/Astro island.
//                   The BOUNDARY is real. The NAME may still be minified, and a
//                   production React build turns every function component into a
//                   single letter, so a name is only reported when it is not one.
//
//   inferred       Nothing claimed the boundary; a repeated DOM shape was found
//                   by clustering. Real enough to be useful, not authoritative.
//                   These go in a separate file with no field called `name`,
//                   because giving a guess the same field as a fact is how a
//                   reconstruction ends up confidently wrong.


/** Run inside the page. Reads only public framework state; nothing is written back. */
import { readRscPayload } from './next-rsc.mjs';

export const COMPONENT_PROBE_SOURCE = `(${function probeComponents(opts) {
  const { maxNodes = 20000, scope = [] } = opts || {};
  const nodes = [...document.querySelectorAll('*')];
  if (nodes.length > maxNodes) return { error: 'page too large', total: nodes.length };

  // A --target run wants the components inside the matched subtrees, not every
  // component on a page it is only borrowing one corner from. Roots resolve here
  // because this probe runs after load, when the DOM the selectors name exists.
  const scopeRoots = [];
  for (const sel of scope) {
    try { scopeRoots.push(...document.querySelectorAll(sel)); } catch { /* not a valid selector */ }
  }
  const inScope = (el) => !scope.length || (!!el && scopeRoots.some((r) => r === el || r.contains(el)));
  // The element a composite renders INTO is its parent in the DOM, so scoping a
  // composite on that host puts it on the wrong side of the boundary whenever
  // the target is a leaf: on a real React 18 tree, AlphaCard's host is div#wrap,
  // which sits above #card-a, and scoping on it dropped every component a
  // --target run exists to find. A component belongs to a subtree if it RENDERS
  // something in it, so scope follows the host elements below the fiber.
  // A container that wraps the target is relevant even though it is not itself
  // inside it: div#wrap holds #card-a, and pruning there would take the whole
  // tree before any component below it was ever looked at.
  const overlapsScope = (el) => scope.length > 0
    && (inScope(el) || scopeRoots.some((r) => el.contains(r)));
  const rendersInScope = (fiber) => {
    if (!scope.length) return true;
    const stack = [fiber];
    let budget = 64; // a component rendering more than 64 hosts is not the point
    while (stack.length && budget-- > 0) {
      const f = stack.pop();
      if (!f) continue;
      const s = f.stateNode;
      if (s && s.nodeType === 1) {
        if (overlapsScope(s)) return true;
        continue; // a host has no host descendants
      }
      // Only downward. Following .sibling here escapes sideways into the next
      // component and made scoping asymmetric: #card-b reported AlphaCard.
      if (f.child) stack.push(f.child);
    }
    return false;
  };
  // The nearest element a fiber sits in, used for the DOM node name. Composite
  // fibers have none of their own, so this climbs to their rendering parent.
  const hostOf = (fiber) => {
    let f = fiber;
    while (f) {
      const s = f.stateNode;
      if (s && s.nodeType === 1) return s;
      f = f.return;
    }
    return null;
  };

  // A stable way to point back at the element a component rendered into. A
  // rebuild works from selectors, because the fiber graph and the vnode tree
  // both disappear the moment the page reloads.
  const cssPath = (el) => {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 8) {
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      let part = node.tagName.toLowerCase();
      // Only class names needing no escaping keep the path short; anything with
      // a space or a bracket would make the selector ambiguous.
      const cls = [...node.classList].filter((c) => /^[A-Za-z0-9_-]+$/.test(c)).slice(0, 2);
      if (cls.length) part += '.' + cls.join('.');
      const parent = node.parentElement;
      if (parent) {
        // nth-of-type only appears when siblings actually collide, so the common
        // case stays a readable descendant path.
        const sibs = [...parent.children].filter(
          (c) => c.tagName === node.tagName && (!cls.length || [...c.classList].some((x) => cls.includes(x))),
        );
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  };

  const keyOf = (el) => Object.keys(el).find((k) =>
    k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance') ||
    k.startsWith('__vue') || k.startsWith('_svelte'));
  const found = [];
  const seen = new Set();

  // --- React ----------------------------------------------------------------
  // Walk the fiber tree, not the elements: a component's own props live on its
  // fiber, and reading the host element would only ever show the DOM attributes
  // React passed down. The tree is walked once from its root, which is also far
  // cheaper than re-walking upward from every element on the page.
  let reactKey = null;
  for (const el of nodes) { const k = keyOf(el); if (k && k.startsWith('__react')) { reactKey = k; break; } }
  if (reactKey) {
    let root = null;
    for (const el of nodes) { const f = el[reactKey]; if (f && (!f.return || !f.return.return)) { root = f.return || f; break; } }
    if (!root) root = nodes.map((el) => el[reactKey]).find(Boolean) || null;
    const stack = root ? [root] : [];
    while (stack.length) {
      const fiber = stack.pop();
      if (!fiber || seen.has(fiber)) continue;
      // No host yet is not the same as out of scope: React roots the tree at a
      // HostRoot fiber whose stateNode is {element: null} and which has no
      // parent to climb to. Pruning on that emptied the result for every React
      // 18 app, so a hostless fiber descends and only a real miss prunes it.
      const host = hostOf(fiber);
      if (rendersInScope(fiber)) {
        seen.add(fiber);
        // With no --target there is no boundary to attribute a hostless fiber to,
        // and the root component is exactly the one a cloner most wants named.
        if (host || !scope.length) {
          const t = fiber.elementType || fiber.type;
          const isHost = typeof t === 'string';
          // fiber.tag is React's internal constant, not a name. Never use it.
          const raw = isHost || !t ? null : (t.displayName || t.name || null);
          const props = fiber.memoizedProps;
          found.push({
            framework: 'react',
            kind: isHost ? 'host' : 'component',
            domNode: (fiber.stateNode && fiber.stateNode.nodeName ? fiber.stateNode.nodeName.toLowerCase() : null),
            hostSelector: cssPath(host),
            componentName: raw,
            rawComponentName: raw,
            propKeys: props && typeof props === 'object' ? Object.keys(props).filter((k) => k !== 'children') : [],
            key: fiber.key === null || fiber.key === undefined ? null : String(fiber.key),
            depth: (() => { let d = 0, f = fiber; while (f.return) { d++; f = f.return; } return d; })(),
          });
        }
        if (fiber.child) stack.push(fiber.child);
      }
      // A sibling is not part of the pruned fiber's subtree. Skipping it with the
      // prune took BetaCard down with AlphaCard, so --target '#card-b' reported
      // nothing at all even though BetaCard sits right inside it.
      if (fiber.sibling) stack.push(fiber.sibling);
    }
  }

  // --- Vue ------------------------------------------------------------------
  for (const el of nodes) {
    const vnode = el.__vueParentComponent || el._vnode || null;
    if (!vnode || !inScope(el)) continue;
    const type = vnode.type || {};
    const raw = typeof type === 'string' ? null : (type.name || type.__name || null);
    found.push({
      framework: 'vue',
      domNode: el.tagName.toLowerCase(),
      hasDomNode: true,
      hostSelector: cssPath(el),
      componentName: raw,
      rawComponentName: raw,
      propKeys: Object.keys(vnode.props || {}),
      key: vnode.key === null || vnode.key === undefined ? null : String(vnode.key),
      depth: 0,
    });
  }

  // --- Vue, from the app handle ----------------------------------------------
  // The per-element pass above walks __vueParentComponent, which is attached to
  // every rendered host element. That misses a component returning a fragment:
  // it renders no element of its own, so nothing carries its handle. The app
  // handle walks the vnode tree directly and finds those. Both are ungated in
  // Vue's production bundle; app._instance is not in that bundle at all and is
  // deliberately never read here.
  const vueRoots = [];
  for (const el of nodes) {
    const app = el.__vue_app__;
    if (app && app._container && app._container._vnode) vueRoots.push(app._container._vnode);
    else if (el._vnode) vueRoots.push(el._vnode);
  }
  for (const root of vueRoots) {
    const stack = [{ v: root, d: 0 }];
    let budget = 4000;
    while (stack.length && budget-- > 0) {
      const { v, d } = stack.pop();
      if (!v || typeof v !== 'object' || d > 40) continue;
      // A vnode's own .el is where it rendered. That is the only thing that can
      // be tested against --target, so it is what scope is checked on.
      if (typeof v.type !== 'string') {
        const t = v.type || {};
        const raw = t.__name || t.name || null;
        if (!scope.length || v.el === undefined || overlapsScope(v.el)) {
          found.push({
            framework: 'vue',
            domNode: v.el && v.el.tagName ? v.el.tagName.toLowerCase() : null,
            hasDomNode: !!(v.el && v.el.tagName),
            hostSelector: cssPath(v.el),
            componentName: raw,
            rawComponentName: raw,
            propKeys: Object.keys(v.props || {}),
            key: v.key === null || v.key === undefined ? null : String(v.key),
            depth: d,
            from: 'vnode-tree',
          });
        }
      }
      if (Array.isArray(v.children)) for (const c of v.children) stack.push({ v: c, d: d + 1 });
      if (v.component && v.component.subTree) stack.push({ v: v.component.subTree, d });
    }
  }

  // --- Svelte ----------------------------------------------------------------
  for (const el of nodes) {
    const key = keyOf(el);
    if (!key || !key.startsWith('_svelte') || !inScope(el)) continue;
    found.push({
      framework: 'svelte',
      domNode: el.tagName.toLowerCase(),
      hasDomNode: true,
      hostSelector: cssPath(el),
      componentName: el[key]?.constructor?.name || null,
      rawComponentName: el[key]?.constructor?.name || null,
      propKeys: [],
      key: null,
      depth: 0,
    });
  }

  return {
    total: nodes.length,
    react: !!reactKey,
    vueRoots: vueRoots.length,
    found,
  };
}})`;

/**
 * Read component boundaries out of a live page.
 *
 * @param {import('playwright').Page} page
 * @param {{maxNodes?: number, scope?: string[]}} [opts] `scope` holds the
 *   --target selectors; when given, only components rendering inside one count.
 */
export async function extractComponents(page, { maxNodes = 20000, scope = [] } = {}) {
  await page.evaluate(`window.__deComponents = ${COMPONENT_PROBE_SOURCE}`);
  const raw = await page.evaluate(`window.__deComponents(${JSON.stringify({ maxNodes, scope })})`);
  await page.evaluate('delete window.__deComponents').catch(() => {});

  // The App Router payload is a separate read of a separate thing: serialized
  // server output, not a live element. Running it here rather than inside the
  // DOM probe keeps one probe to one source of truth.
  const rsc = await readRscPayload(page);
  return classify({ ...raw, found: [...(raw?.found || []), ...(rsc.found || [])], rscChunks: rsc.chunks });
}

/**
 * A production build renames every function component to a single letter. That
 * name is real but carries no information, so it is kept in `rawComponentName`
 * for a human and withheld from `componentName`, which everything downstream
 * treats as an identity.
 */
export function meaningfulName(name) {
  // A numeric string is an internal React constant, not a name.
  if (/^\d+$/.test(name)) return null;
  if (typeof name !== 'string' || !name) return null;
  return /^[A-Za-z_$][\w$]?$/.test(name) && name.length <= 2 ? null : name;
}

/** Split the probe output into the authoritative list and the rest. */
export function classify(raw) {
  const found = raw?.found || [];
  return {
    total: raw?.total ?? 0,
    error: raw?.error || null,
    authoritative: found.map((f) => {
      const name = meaningfulName(f.componentName);
      return {
        framework: f.framework,
        componentName: name,
        // The untruncated name is kept so a human can match it against the source,
        // but nothing downstream reads it as a component identity.
        rawComponentName: f.rawComponentName,
        domNode: f.domNode,
        hostSelector: f.hostSelector || null,
        propKeys: f.propKeys || [],
        key: f.key,
        depth: f.depth,
        named: name !== null,
        // How much the name is worth. A production build renames every React
        // function component to one letter, so the name is real but carries no
        // information; a consumer must be able to see that at a glance rather
        // than infer it from a name that looks plausible.
        captureConfidence: name !== null ? 'named' : 'anonymous',
        from: f.from || 'element-handle',
        clientBoundary: f.clientBoundary || false,
        scopeAttributable: f.scopeAttributable !== false,
      };
    }),
    unnamed: found.filter((f) => meaningfulName(f.componentName) === null).length,
  };
}

/**
 * Cluster elements that share a tag and class signature.
 *
 * This is inference, not a component boundary. A card repeated twelve times is
 * very likely one component, and also possibly twelve hand-written copies; the
 * output says which belief it is.
 */
export function clusterBySignature(elements, { minSize = 2 } = {}) {
  const groups = new Map();
  for (const el of elements) {
    const key = `${el.tag}::${[...el.classes].sort().join('.')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(el);
  }
  const clusters = [];
  let id = 0;
  for (const [key, members] of groups) {
    if (members.length < minSize) continue;
    const [tag, classPart] = key.split('::');
    clusters.push({
      clusterId: `c${id++}`,
      signature: key,
      domTag: tag,
      classList: classPart ? classPart.split('.').filter(Boolean) : [],
      count: members.length,
      // Deliberately not `name`: these clusters have no name, and a field called
      // `name` would be read as one by anything downstream.
      candidateLabels: labelsFor(members),
      sampleHtml: members[0].html.slice(0, 400),
    });
  }
  clusters.sort((a, b) => b.count - a.count);
  return clusters;
}

function labelsFor(members) {
  const counts = new Map();
  for (const el of members) {
    // The shape records carry plain fields, never live elements, so this reads
    // them directly. Reaching for el.getAttribute here (as an earlier version
    // did) silently yielded nothing on every shape, and candidateLabels came
    // back empty for every cluster on every page.
    const label = (el.ariaLabel || el.text || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!label) continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([label]) => label);
}
