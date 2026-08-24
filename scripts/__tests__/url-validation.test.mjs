import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateUrl } from '../cli.mjs';

// Stub resolver: returns a single public IPv4 address. Avoids real DNS in tests.
const publicResolver = () => Promise.resolve([{ address: '1.1.1.1' }]);

test('validateUrl rejects private IP without allowPrivate', async () => {
  await assert.rejects(
    validateUrl('http://169.254.169.254/', { allowPrivate: false }),
    /private\/loopback/,
  );
});

test('validateUrl accepts private IP when allowPrivate is true', async () => {
  await assert.doesNotReject(
    validateUrl('http://169.254.169.254/', { allowPrivate: true }),
  );
});

test('validateUrl rejects disallowed scheme', async () => {
  await assert.rejects(
    validateUrl('file:///etc/passwd'),
    /scheme/,
  );
});

test('validateUrl resolves true for public host with stub resolver', async () => {
  const out = await validateUrl('http://example.com/', { resolver: publicResolver });
  assert.equal(out, true);
});
