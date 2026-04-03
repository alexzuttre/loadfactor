import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSignedPayload, encodeSignedPayload, parseCookies } from './session.js';
import { normalizeEmail, isAccessAdmin, isImmutableAdminEmail } from './access.js';
import { assertRuntimeConfig } from './config.js';
import { clearPermissionCache, getEnvironmentDecision, REQUIRED_PERMISSIONS } from './permissions.js';
import { buildEnvironmentPermissionTargets } from './loadfactor-data.js';

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

test('admin access requires active admin role', () => {
  assert.equal(isAccessAdmin({ role: 'admin', status: 'active' }), true);
  assert.equal(isAccessAdmin({ role: 'viewer', status: 'active' }), false);
  assert.equal(isAccessAdmin({ role: 'admin', status: 'disabled' }), false);
});

test('alex admin record is immutable', () => {
  assert.equal(isImmutableAdminEmail('alex.zuttre@flyr.com'), true);
  assert.equal(isImmutableAdminEmail(' Alex.Zuttre@flyr.com '), true);
  assert.equal(isImmutableAdminEmail('someone.else@flyr.com'), false);
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

test('permission targets include both spanner databases for an environment', () => {
  const targets = buildEnvironmentPermissionTargets('rx-prd');
  assert.equal(targets.length, 2);
  assert.equal(targets[0].key, 'stockkeeper');
  assert.equal(targets[1].key, 'productcatalog-search');
  assert.equal(targets.every((target) => target.fullResourceName.startsWith('//spanner.googleapis.com/projects/')), true);
});

test('required permission list covers session creation', () => {
  assert.deepEqual(REQUIRED_PERMISSIONS, ['spanner.sessions.create']);
});

test('environment decision lookup returns matching environment result', () => {
  const decision = getEnvironmentDecision({
    environmentAccess: [
      { environment: 'rx-int', status: 'allowed', reason: 'all_permissions_granted' },
      { environment: 'rx-prd', status: 'denied', reason: 'permission_not_granted' },
    ],
  }, 'rx-prd');
  assert.deepEqual(decision, {
    environment: 'rx-prd',
    status: 'denied',
    reason: 'permission_not_granted',
  });
});

test.after(() => {
  clearPermissionCache();
});
