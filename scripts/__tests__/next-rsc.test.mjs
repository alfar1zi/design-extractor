import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readRscPayload, RSC_PROBE_SOURCE } from '../next-rsc.mjs';

async function onPage(html, fn) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return await fn(page);
  } finally {
    await browser.close();
  }
}

test('a page with no App Router payload reports it rather than pretending it read one', async () => {
  const got = await onPage('<html><body><p>plain</p></body></html>', (page) => readRscPayload(page));
  assert.equal(got.present, false);
  assert.deepEqual(got.found, []);
});

test('an element row becomes a real element, not a boundary', async () => {
  const row = ['$', 'div', null, { className: 'hero', children: [] }];
  const got = await onPage(
    `<script>self.__next_f=[${JSON.stringify([1, '0:' + JSON.stringify(row)])}]</script>`,
    (page) => readRscPayload(page),
  );

  assert.equal(got.present, true);
  assert.equal(got.chunks, 1);
  const [entry] = got.found;
  assert.equal(entry.domNode, 'div');
  assert.equal(entry.clientBoundary, false);
  assert.deepEqual(entry.propKeys, ['className', 'children']);
});

test('a $L reference is a client boundary and is never given an element or a name', async () => {
  const row = ['$', 'L2a3f9bc', 'k1', { title: 'Pricing' }];
  const got = await onPage(
    `<script>self.__next_f=[${JSON.stringify([1, '0:' + JSON.stringify(row)])}]</script>`,
    (page) => readRscPayload(page),
  );

  const [entry] = got.found;
  assert.equal(entry.clientBoundary, true, 'the reference is recognised as a boundary');
  assert.equal(entry.domNode, null, 'a webpack id is not an HTML element');
  assert.equal(entry.componentName, null, 'nothing here recovers a component name');
  assert.equal(entry.rawComponentName, 'L2a3f9bc', 'the id is kept for a human, not as an identity');
});

test('a chunk that is not JSON does not abandon the chunks after it', async () => {
  const good = ['$', 'section', null, {}];
  const got = await onPage(
    `<script>self.__next_f=[${JSON.stringify([1, '0:{not json'])},${JSON.stringify([1, '1:' + JSON.stringify(good)])}]</script>`,
    (page) => readRscPayload(page),
  );

  assert.equal(got.chunks, 2);
  assert.deepEqual(got.found.map((f) => f.domNode), ['section'], 'the readable row still comes through');
});

test('reading the payload twice gives the same answer, so the page was left intact', async () => {
  const row = ['$', 'main', null, {}];
  await onPage(
    `<script>self.__next_f=[${JSON.stringify([1, '0:' + JSON.stringify(row)])}]</script>`,
    async (page) => {
      const first = await readRscPayload(page);
      const second = await readRscPayload(page);
      assert.deepEqual(second.found, first.found,
        'a second read returns the same rows, so the first did not consume the payload');
      assert.deepEqual(await page.evaluate(() => Array.isArray(self.__next_f)), true,
        'the page still owns its payload after the pass ran');
    },
  );
});
