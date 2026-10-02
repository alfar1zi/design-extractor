import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { extractComponents, classify, clusterBySignature, COMPONENT_PROBE_SOURCE } from '../components.mjs';
import { collectShapes } from '../components-pass.mjs';

test('a page with no framework reports nothing authoritative', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="card"><p>hi</p></div>');
    const data = await extractComponents(page);
    assert.deepEqual(data.authoritative, []);
    assert.equal(data.error, null);
  } finally {
    await browser.close();
  }
});

test('a real React app yields the component boundaries the framework reports', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // React from a CDN, one real named component, to prove the fiber walk works.
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ url: 'https://unpkg.com/react@18/umd/react.production.min.js' });
    await page.addScriptTag({ url: 'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js' });
    await page.evaluate(() => {
      const h = React.createElement;
      function ProductCard(props) { return h('div', { className: 'card' }, h('span', null, props.title)); }
      const root = ReactDOM.createRoot(document.getElementById('root'));
      root.render(h('div', null, [1, 2, 3].map((i) => h(ProductCard, { key: i, title: 'Item ' + i }))));
    });
    await page.waitForSelector('.card');
    // React attaches the fiber keys in a commit; poll for them rather than
    // sleeping a fixed amount and hoping the render landed first.
    await page.waitForFunction(() => Object.keys(document.body.querySelector('.card')).some((k) => k.startsWith('__reactFiber')));

    const data = await extractComponents(page);
    const react = data.authoritative.filter((c) => c.framework === 'react');
    assert.ok(react.length > 0, 'React fibers were found');
    // The boundary is authoritative even though a production build minified the name.
    const cards = react.filter((c) => c.domNode === 'div');
    assert.ok(cards.length > 0, 'the component boundaries are reported');
    const named = react.filter((c) => c.named);
    for (const c of named) {
      assert.ok(c.componentName.length > 2,
        'a one- or two-letter name is minification noise and must not be reported as a name');
    }
    assert.ok(react.some((c) => c.propKeys.includes('title')), 'real props are visible');
  } finally {
    await browser.close();
  }
});

test('a composite fiber is kept or dropped by the element it renders, not by the subtree it sits in', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="wrap"><section id="card-a"><p id="alpha">A</p></section>'
      + '<section id="card-b"><p id="beta">B</p></section></div>');
    // Shaped like a real React 18 tree, verified against react-dom 18: a
    // composite fiber is the PARENT of the hosts it renders, and the tree is
    // rooted at a HostRoot whose stateNode is {element: null}. Scoping on the
    // element a component renders INTO therefore puts both sibling components on
    // the same side of the boundary, which is what this pins.
    await page.evaluate(() => {
      const fiber = (stateNode, elementType, props, parent) => ({
        stateNode, elementType, memoizedProps: props, key: null,
        return: parent, child: null, sibling: null,
      });
      const wrap = document.getElementById('wrap');
      const hostRoot = fiber({ element: null }, null, {}, null);
      const app = fiber(null, { name: 'App' }, {}, hostRoot);
      const wrapHost = fiber(wrap, 'div', {}, app);
      const alphaCard = fiber(null, { name: 'AlphaCard' }, { alphaProp: 1 }, wrapHost);
      const betaCard = fiber(null, { name: 'BetaCard' }, { betaProp: 1 }, wrapHost);
      const hostA = fiber(document.getElementById('card-a'), 'section', {}, alphaCard);
      const hostB = fiber(document.getElementById('card-b'), 'section', {}, betaCard);
      hostRoot.child = app;
      app.child = wrapHost;
      // App renders div#wrap; div#wrap renders AlphaCard and BetaCard; each of
      // those renders its own section. That nesting is what makes AlphaCard's
      // nearest host element div#wrap, the one scoping must not use.
      wrapHost.child = alphaCard;
      alphaCard.sibling = betaCard;
      alphaCard.child = hostA;
      betaCard.child = hostB;
      wrap.__reactFiber$abc = wrapHost;
      hostA.stateNode.__reactFiber$abc = hostA;
      hostB.stateNode.__reactFiber$abc = hostB;
    });

    const unscoped = await extractComponents(page);
    assert.ok(unscoped.authoritative.some((c) => c.componentName === 'BetaCard'),
      'the untargeted subtree is visible without a scope, so the scoped run has something to exclude');

    const scoped = await extractComponents(page, { scope: ['#card-a'] });
    assert.ok(scoped.authoritative.some((c) => c.componentName === 'AlphaCard' && c.propKeys.includes('alphaProp')),
      'a component fiber has no host node of its own; it survives when the element it renders is in scope');
    assert.equal(scoped.authoritative.filter((c) => c.componentName === 'BetaCard').length, 0,
      'a fiber rendering outside every scope root is dropped');
    assert.equal(scoped.authoritative.filter((c) => c.propKeys.includes('betaProp')).length, 0,
      'its props must not leak either, even though its fiber is a sibling of the kept one');
  } finally {
    await browser.close();
  }
});

test('a --target run drops the other subtree whichever framework marked it', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="card-a"><span>A</span></div><div id="card-b"><span>B</span></div>');
    // Vue and Svelte mark elements directly, so the fixture is the expando a
    // real page would have set, not a fiber tree.
    await page.evaluate(() => {
      document.querySelector('#card-a span').__vueParentComponent = { type: { __name: 'AlphaPanel' }, props: { alphaProp: true }, key: null };
      document.querySelector('#card-b span')._svelte = { constructor: { name: 'BetaPanel' } };
    });

    const unscoped = await extractComponents(page);
    assert.deepEqual(unscoped.authoritative.map((c) => c.framework).sort(), ['svelte', 'vue'],
      'both markers are read when nothing is targeted');

    const scoped = await extractComponents(page, { scope: ['#card-a'] });
    assert.deepEqual(scoped.authoritative.map((c) => c.framework), ['vue'], 'only the targeted subtree is read');
    assert.equal(scoped.authoritative[0].componentName, 'AlphaPanel');
    assert.deepEqual(scoped.authoritative[0].propKeys, ['alphaProp']);
  } finally {
    await browser.close();
  }
});

test('shapes are clustered only from inside the targeted subtree', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div id="card-a"><article class="card">A one</article><article class="card">A two</article></div>
      <div id="card-b"><section class="panel">B one</section><section class="panel">B two</section></div>
    `);

    const all = await collectShapes(page);
    assert.ok(all.some((s) => s.classes.includes('panel')),
      'the untargeted subtree contributes shapes without a scope, so the scoped run has something to exclude');

    const scoped = await collectShapes(page, { scope: ['#card-a'] });
    assert.ok(scoped.some((s) => s.html.includes('id="card-a"')), 'the scope root itself is inside the scope');
    assert.ok(scoped.some((s) => s.classes.includes('card')), 'the targeted subtree still contributes its own shapes');
    for (const shape of scoped) {
      assert.equal(shape.classes.includes('panel'), false, `a shape from outside the scope survived: ${shape.html}`);
    }
  } finally {
    await browser.close();
  }
});

test('a minified component name is dropped, not guessed at', () => {
  const data = classify({
    total: 1,
    found: [
      { framework: 'react', domNode: 'div', componentName: 'L', rawComponentName: 'L', propKeys: [], key: null, depth: 0 },
      { framework: 'react', domNode: 'div', componentName: 'ProductCard', rawComponentName: 'ProductCard', propKeys: [], key: null, depth: 0 },
    ],
  });
  assert.equal(data.authoritative[0].componentName, null);
  assert.equal(data.authoritative[0].named, false);
  assert.equal(data.authoritative[0].rawComponentName, 'L', 'the raw name is kept for a human to match');
  assert.equal(data.authoritative[1].componentName, 'ProductCard');
  assert.equal(data.unnamed, 1);
});

test('a page too large to probe says so instead of returning half a page', () => {
  const data = classify({ error: 'page too large', total: 99999, found: [{ framework: 'react', domNode: 'div', componentName: 'x'.repeat(5), rawComponentName: 'Xx', propKeys: [], key: null, depth: 0 }] });
  assert.equal(data.error, 'page too large');
});

test('repeated DOM shapes cluster by tag and class signature', () => {
  const el = (tag, classes, text = '') => ({ tag, classes, ariaLabel: '', text: text, html: `<${tag}>` });
  const clusters = clusterBySignature([
    el('article', ['card'], 'Alpha'), el('article', ['card'], 'Beta'), el('article', ['card'], 'Gamma'),
    el('aside', ['note'], 'One'),
  ]);
  assert.equal(clusters.length, 1, 'a single article is not a repeated shape');
  assert.equal(clusters[0].count, 3);
  assert.equal(clusters[0].domTag, 'article');
  assert.deepEqual(clusters[0].classList, ['card']);
  assert.deepEqual(clusters[0].candidateLabels, ['Alpha', 'Beta', 'Gamma']);
});

test('class order does not change the cluster key', () => {
  const el = (classes) => ({ tag: 'div', classes, ariaLabel: '', text: '', html: '<div>' });
  const [a] = clusterBySignature([el(['b', 'a']), el(['a', 'b'])]);
  assert.deepEqual(a.classList, ['a', 'b']);
});

test('an inferred cluster has no field called name', () => {
  const el = (classes) => ({ tag: 'div', classes, ariaLabel: '', text: '', html: '<div>' });
  const [cluster] = clusterBySignature([el(['a']), el(['a'])]);
  assert.equal(cluster.name, undefined, 'a cluster is not a component and must not be named like one');
  assert.equal(cluster.clusterId, 'c0');
  assert.ok(cluster.candidateLabels);
});

test('the probe never writes to the page it is reading', () => {
  assert.equal(/__deComponents/.test(COMPONENT_PROBE_SOURCE), false,
    'the probe body itself must not reference the handle it is stored under');
});

test('candidateLabels survive the real collector, not just a hand-built shape', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <section class="plan-list">
        <article class="card"><h3>Pro</h3><p>Everything</p></article>
        <article class="card"><h3>Team</h3><p>Shared</p></article>
        <article class="card"><h3>Solo</h3><p>Just you</p></article>
      </section>`);
    const shapes = await collectShapes(page);
    const [cluster] = clusterBySignature(shapes);

    assert.ok(cluster, 'the repeated card shape is one cluster');
    assert.equal(cluster.count, 3);
    // Every label comes from a real element's text. An earlier version of the
    // label reader reached for getAttribute/textContent, which the collector's
    // own shape records do not have, so this came back empty on every page in
    // production while a hand-built fixture made the unit test look green.
    assert.deepEqual(
      cluster.candidateLabels.sort(),
      ['Pro Everything', 'Solo Just you', 'Team Shared'].sort(),
      'labels are read off the DOM the collector actually produced',
    );
  } finally {
    await browser.close();
  }
});

test('a fragment component is found through the app handle even with no element of its own', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="app"><ul><li>a</li><li>b</li></ul></div>');
    // A component returning a fragment renders no element, so nothing carries its
    // __vueParentComponent handle. The app handle is the only way to see it, and
    // on a production build app._instance is absent entirely, so _container._vnode
    // is the only tree that exists.
    await page.evaluate(() => {
      const host = document.querySelector('#app ul');
      const frag = {
        type: { __name: 'FeatureList' },
        props: { items: ['a', 'b'] },
        children: [{ type: 'li', el: host.children[0], children: [] }],
      };
      const app = { _container: { _vnode: { type: {}, component: { subTree: frag } } } };
      document.getElementById('app').__vue_app__ = app;
    });

    const { authoritative } = await extractComponents(page);
    const frag = authoritative.find((c) => c.componentName === 'FeatureList');

    assert.ok(frag, 'the fragment component is in the authoritative list');
    assert.equal(frag.framework, 'vue');
    assert.equal(frag.captureConfidence, 'named');
    assert.equal(frag.from, 'vnode-tree');
    assert.deepEqual(frag.propKeys, ['items'], 'its props come from the vnode, not the DOM attributes');
  } finally {
    await browser.close();
  }
});
