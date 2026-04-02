import crypto from 'crypto';

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeBase64UrlJson(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

export function signCookieValue(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

export function encodeSignedPayload(payload, secret) {
  const encoded = base64UrlJson(payload);
  return `${encoded}.${signCookieValue(encoded, secret)}`;
}

export function decodeSignedPayload(value, secret) {
  if (!value || !secret) return null;
  const [encoded, signature] = String(value).split('.');
  if (!encoded || !signature) return null;

  const expected = signCookieValue(encoded, secret);
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== signatureBuffer.length) return null;
  if (!crypto.timingSafeEqual(expectedBuffer, signatureBuffer)) return null;

  try {
    const payload = decodeBase64UrlJson(encoded);
    if (payload?.exp && Date.now() >= payload.exp * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const cookies = {};
  for (const fragment of String(header || '').split(';')) {
    const part = fragment.trim();
    if (!part) continue;
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

export function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || '/'}`);

  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.maxAge != null) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);

  return parts.join('; ');
}

export function clearCookie(name, options = {}) {
  return serializeCookie(name, '', {
    ...options,
    maxAge: 0,
    expires: new Date(0),
  });
}

export function setSignedCookie(res, name, payload, secret, options = {}) {
  res.append('Set-Cookie', serializeCookie(name, encodeSignedPayload(payload, secret), options));
}

export function clearSignedCookie(res, name, options = {}) {
  res.append('Set-Cookie', clearCookie(name, options));
}

export function readSignedCookie(req, name, secret) {
  const cookies = parseCookies(req.headers.cookie);
  return decodeSignedPayload(cookies[name], secret);
}

export function makeExpiringPayload(payload, maxAgeSeconds) {
  const now = Math.floor(Date.now() / 1000);
  return {
    ...payload,
    iat: now,
    exp: now + maxAgeSeconds,
  };
}
