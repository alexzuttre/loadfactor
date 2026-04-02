import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSignedPayload, encodeSignedPayload, parseCookies } from './session.js';
import { normalizeEmail } from './access.js';
import { assertRuntimeConfig } from './config.js';

test('signed payload round-trips until expiry', () => {
  const value = encodeSignedPayload({ email: 'alex@example.com', exp: Math.floor(Date.now() / 1000) + 60 }, 'secret');
  const decoded = decodeSignedPayload(value, 'secret');
  assert.equal(decoded.email, 'alex@example.com');
});

test('signed payload rejects tampering', () => {
  const value = encodeSignedPayload({ email: 'alex@example.com', exp: Math.floor(Date.now() / 1000) + 60 }, 'secret');
  const tampered = `${value.slice(0, -1)}x`;
  assert.equal(decodeSignedPayload(tampered, 'secret'), null);
});

test('cookie parsing handles multiple fragments', () => {
  const cookies = parseCookies('a=1; b=hello%40example.com');
  assert.deepEqual(cookies, { a: '1', b: 'hello@example.com' });
});

test('email normalization trims and lowercases', () => {
  assert.equal(normalizeEmail('  Alex@Example.COM '), 'alex@example.com');
});

test('production rejects dev auth bypass', () => {
  assert.throws(() => {
    assertRuntimeConfig({
      authMode: 'okta',
      isProduction: true,
      devAuthBypass: true,
      sessionSecret: 'secret',
      appBaseUrl: 'https://example.com',
      oktaIssuer: 'https://issuer.example.com',
      oktaClientId: 'client',
      oktaClientSecret: 'secret',
    });
  }, /DEV_AUTH_BYPASS must be false in production/);
});

test('iap mode allows startup without expected audience for temporary deployment', () => {
  assert.doesNotThrow(() => {
    assertRuntimeConfig({
      authMode: 'iap',
      isProduction: false,
      devAuthBypass: false,
      sessionSecret: 'secret',
      iapExpectedAudience: '',
    });
  });
});

test('okta mode requires issuer and client credentials when bypass is disabled', () => {
  assert.throws(() => {
    assertRuntimeConfig({
      authMode: 'okta',
      isProduction: false,
      devAuthBypass: false,
      sessionSecret: 'secret',
      oktaIssuer: '',
      oktaClientId: '',
      oktaClientSecret: '',
    });
  }, /Missing required Okta settings: OKTA_ISSUER, OKTA_CLIENT_ID, OKTA_CLIENT_SECRET/);
});
