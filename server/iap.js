import { createRemoteJWKSet, jwtVerify } from 'jose';

const IAP_JWKS_URL = 'https://www.gstatic.com/iap/verify/public_key-jwk';
const jwks = createRemoteJWKSet(new URL(IAP_JWKS_URL));

function normalizeGoogleIdentity(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const prefix = 'accounts.google.com:';
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

export function isIapConfigured(config) {
  return config.authMode === 'iap';
}

function markIapError(message) {
  const error = new Error(message);
  error.code = 'IAP_AUTH_ERROR';
  return error;
}

export async function verifyIapRequest(req, config) {
  const assertion = req.headers['x-goog-iap-jwt-assertion'];
  if (!assertion) return null;

  let verification;
  try {
    const verifyOptions = {
      issuer: 'https://cloud.google.com/iap',
      algorithms: ['ES256'],
    };
    if (config.iapExpectedAudience) {
      verifyOptions.audience = config.iapExpectedAudience;
    }

    verification = await jwtVerify(String(assertion), jwks, verifyOptions);
  } catch (error) {
    throw markIapError(`Invalid IAP assertion: ${error.message}`);
  }

  const { payload, protectedHeader } = verification;

  const headerEmail = normalizeGoogleIdentity(req.headers['x-goog-authenticated-user-email']);
  const tokenEmail = String(payload.email || '').trim().toLowerCase();
  if (!tokenEmail) {
    throw markIapError('IAP assertion did not include an email claim.');
  }
  if (headerEmail && headerEmail.toLowerCase() !== tokenEmail) {
    throw markIapError('IAP email header did not match the signed JWT.');
  }

  if (config.iapAllowedDomain) {
    const hostedDomain = String(payload.hd || '').trim().toLowerCase();
    if (hostedDomain !== config.iapAllowedDomain) {
      throw markIapError(`IAP hosted domain mismatch: expected ${config.iapAllowedDomain}, got ${hostedDomain || 'none'}.`);
    }
  }

  return {
    sub: String(payload.sub || '').trim(),
    email: tokenEmail,
    displayName: tokenEmail,
    authProvider: 'iap',
    iap: {
      aud: String(payload.aud || ''),
      iss: String(payload.iss || ''),
      kid: String(protectedHeader.kid || ''),
      hd: String(payload.hd || '').trim().toLowerCase() || null,
      audienceVerified: Boolean(config.iapExpectedAudience),
    },
  };
}
