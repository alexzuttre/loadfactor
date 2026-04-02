import crypto from 'crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const discoveryCache = new Map();
const jwksCache = new Map();

function randomValue(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function codeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status} from ${url}: ${body.slice(0, 200)}`);
  }
  return response.json();
}

export function isOktaConfigured(config) {
  return Boolean(config.oktaIssuer && config.oktaClientId && config.oktaClientSecret && config.appBaseUrl);
}

export async function getDiscoveryDocument(config) {
  if (!discoveryCache.has(config.oktaIssuer)) {
    const url = `${config.oktaIssuer}/.well-known/openid-configuration`;
    discoveryCache.set(config.oktaIssuer, fetchJson(url));
  }
  return discoveryCache.get(config.oktaIssuer);
}

function getRemoteJwks(jwksUri) {
  if (!jwksCache.has(jwksUri)) {
    jwksCache.set(jwksUri, createRemoteJWKSet(new URL(jwksUri)));
  }
  return jwksCache.get(jwksUri);
}

export function createLoginTransaction(config, returnTo = '/') {
  return {
    state: randomValue(24),
    nonce: randomValue(24),
    codeVerifier: randomValue(48),
    returnTo,
    exp: Math.floor(Date.now() / 1000) + config.authStateMaxAgeSeconds,
  };
}

export function buildAuthorizeUrl(config, discovery, transaction) {
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('client_id', config.oktaClientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', `${config.appBaseUrl}/auth/callback`);
  url.searchParams.set('scope', config.oktaScopes);
  url.searchParams.set('state', transaction.state);
  url.searchParams.set('nonce', transaction.nonce);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', codeChallenge(transaction.codeVerifier));
  return url.toString();
}

export async function exchangeCode(config, discovery, { code, codeVerifier }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: `${config.appBaseUrl}/auth/callback`,
    client_id: config.oktaClientId,
    code_verifier: codeVerifier,
  });

  const authHeader = Buffer.from(`${config.oktaClientId}:${config.oktaClientSecret}`).toString('base64');
  return fetchJson(discovery.token_endpoint, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Authorization': `Basic ${authHeader}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
}

export async function verifyIdToken(config, discovery, idToken, expectedNonce) {
  const jwks = getRemoteJwks(discovery.jwks_uri);
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: config.oktaIssuer,
    audience: config.oktaClientId,
  });

  if (payload.nonce !== expectedNonce) {
    throw new Error('Okta nonce mismatch.');
  }

  return {
    sub: String(payload.sub || '').trim(),
    email: String(payload.email || '').trim().toLowerCase(),
    displayName: String(payload.name || payload.preferred_username || payload.email || payload.sub || '').trim(),
  };
}

export async function fetchUserInfo(discovery, accessToken) {
  if (!discovery.userinfo_endpoint) return {};
  return fetchJson(discovery.userinfo_endpoint, {
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
  });
}
