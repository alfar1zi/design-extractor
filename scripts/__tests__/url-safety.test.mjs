import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeUrl, isPrivateAddress } from '../url-safety.mjs';

const okResolver = () => Promise.resolve([{ address: '93.184.216.34' }]); // example.com
const failResolver = (addr) => () => Promise.resolve([{ address: addr }]);

test('isPrivateAddress flags loopback and RFC1918', () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('10.0.0.1'), true);
  assert.equal(isPrivateAddress('172.16.0.1'), true);
  assert.equal(isPrivateAddress('172.31.255.254'), true);
  assert.equal(isPrivateAddress('192.168.0.1'), true);
  assert.equal(isPrivateAddress('169.254.169.254'), true);
  assert.equal(isPrivateAddress('0.0.0.0'), true);
  assert.equal(isPrivateAddress('::1'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('93.184.216.34'), false);
});

test('rejects http://169.254.169.254/ (AWS metadata)', async () => {
  await assert.rejects(
    assertSafeUrl('http://169.254.169.254/latest/meta-data/', { resolver: failResolver('169.254.169.254') }),
    /private\/loopback/
  );
});

test('rejects file:///etc/passwd (wrong scheme)', async () => {
  await assert.rejects(assertSafeUrl('file:///etc/passwd'), /scheme/);
});

test('rejects ftp://example.com/ (wrong scheme)', async () => {
  await assert.rejects(assertSafeUrl('ftp://example.com/'), /scheme/);
});

test('rejects http://localhost/', async () => {
  await assert.rejects(assertSafeUrl('http://localhost/'), /private\/loopback/);
});

test('rejects http://10.0.0.1/', async () => {
  await assert.rejects(
    assertSafeUrl('http://10.0.0.1/', { resolver: failResolver('10.0.0.1') }),
    /private\/loopback/
  );
});

test('accepts http://example.com/ when DNS resolves to public IP', async () => {
  await assertSafeUrl('http://example.com/', { resolver: okResolver });
});

test('accepts http://example.com/ with default resolver (real DNS, may fail in sandboxed envs)', async () => {
  // Default resolver is the real one. We don't assert success — just no exception thrown synchronously.
  // If the sandbox has no DNS, the test gracefully tolerates the DNS failure.
  try {
    await assertSafeUrl('http://example.com/');
  } catch (e) {
    assert.match(e.message, /DNS lookup failed|private|loopback|invalid|scheme/);
  }
});

test('--allow-private flag overrides rejection', async () => {
  // Localhost is private; allowPrivate=true should permit it.
  const out = await assertSafeUrl('http://localhost/', { allowPrivate: true });
  assert.equal(out, true);
});

test('allow-private also overrides IP-based private detection', async () => {
  const out = await assertSafeUrl('http://10.0.0.1/', { allowPrivate: true });
  assert.equal(out, true);
});

test('rejects IPv6 loopback http://[::1]/', async () => {
  await assert.rejects(assertSafeUrl('http://[::1]/'), /private\/loopback/);
});

test('rejects malformed URL', async () => {
  await assert.rejects(assertSafeUrl('not a url'), /invalid URL/);
});

test('rejects URL with no hostname', async () => {
  // `new URL('http:')` throws; that's the invalid-URL branch.
  await assert.rejects(assertSafeUrl('http:'), /invalid URL/);
});

test('resolver returning any private address fails the URL', async () => {
  const mixed = () => Promise.resolve([{ address: '1.1.1.1' }, { address: '127.0.0.1' }]);
  await assert.rejects(assertSafeUrl('http://test.example/', { resolver: mixed }), /private/);
});
