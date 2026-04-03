import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
export const INDEX_HTML_PATH = path.join(DIST_DIR, 'index.html');
const LOCAL_ENV_PATH = path.join(PROJECT_ROOT, '.env.local');

if (fs.existsSync(LOCAL_ENV_PATH)) {
  dotenv.config({ path: LOCAL_ENV_PATH, override: true });
}

function parseBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';
  const port = parseNumber(env.PORT, 3001);
  const authMode = String(env.AUTH_MODE || 'okta').trim().toLowerCase();
  const appBaseUrl = String(env.APP_BASE_URL || (!isProduction ? `http://127.0.0.1:${port}` : ''))
    .trim()
    .replace(/\/+$/, '');

  return {
    authMode,
    nodeEnv,
    isProduction,
    port,
    appBaseUrl,
    serviceName: String(env.K_SERVICE || 'loadfactor').trim() || 'loadfactor',
    googleCloudProject: String(env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || '').trim(),
    googleCloudProjectNumber: String(env.GOOGLE_CLOUD_PROJECT_NUMBER || env.GCLOUD_PROJECT_NUMBER || '').trim(),
    sessionSecret: String(env.SESSION_SECRET || '').trim(),
    sessionCookieName: String(env.SESSION_COOKIE_NAME || 'loadfactor_session').trim(),
    authStateCookieName: String(env.AUTH_STATE_COOKIE_NAME || 'loadfactor_auth_state').trim(),
    sessionMaxAgeSeconds: parseNumber(env.SESSION_MAX_AGE_SECONDS, 12 * 60 * 60),
    authStateMaxAgeSeconds: parseNumber(env.AUTH_STATE_MAX_AGE_SECONDS, 10 * 60),
    cookieSecure: parseBoolean(env.COOKIE_SECURE, isProduction),
    oktaIssuer: String(env.OKTA_ISSUER || '').trim().replace(/\/+$/, ''),
    oktaClientId: String(env.OKTA_CLIENT_ID || '').trim(),
    oktaClientSecret: String(env.OKTA_CLIENT_SECRET || '').trim(),
    oktaScopes: String(env.OKTA_SCOPES || 'openid profile email').trim(),
    iapExpectedAudience: String(env.IAP_EXPECTED_AUDIENCE || '').trim(),
    iapAllowedDomain: String(env.IAP_ALLOWED_DOMAIN || '').trim().toLowerCase(),
    gcpOrganizationId: String(env.GCP_ORGANIZATION_ID || '256890650197').trim(),
    permissionCacheTtlMs: parseNumber(env.PERMISSION_CACHE_TTL_MS, 10 * 60 * 1000),
    spannerBuiltInMetricsEnabled: parseBoolean(env.SPANNER_BUILT_IN_METRICS_ENABLED, false),
    bootstrapAdminEmails: parseCsv(env.BOOTSTRAP_ADMIN_EMAILS).map((email) => email.toLowerCase()),
    devAuthBypass: parseBoolean(env.DEV_AUTH_BYPASS, !isProduction),
    devAuthBypassEmail: String(env.DEV_AUTH_BYPASS_EMAIL || 'developer@local.test').trim().toLowerCase(),
    devAuthBypassName: String(env.DEV_AUTH_BYPASS_NAME || 'Local Developer').trim(),
  };
}

export function assertRuntimeConfig(config) {
  if (!['okta', 'iap'].includes(config.authMode)) {
    throw new Error(`Unsupported AUTH_MODE: ${config.authMode}`);
  }

  if (config.isProduction && config.devAuthBypass) {
    throw new Error('DEV_AUTH_BYPASS must be false in production.');
  }

  if (!config.devAuthBypass && !config.sessionSecret) {
    throw new Error('SESSION_SECRET is required unless DEV_AUTH_BYPASS is enabled.');
  }

  if (!config.devAuthBypass && config.authMode === 'okta') {
    const required = [
      ['OKTA_ISSUER', config.oktaIssuer],
      ['OKTA_CLIENT_ID', config.oktaClientId],
      ['OKTA_CLIENT_SECRET', config.oktaClientSecret],
    ].filter(([, value]) => !value);

    if (required.length) {
      throw new Error(`Missing required Okta settings: ${required.map(([name]) => name).join(', ')}`);
    }
  }

  if (config.isProduction) {
    const required = [
      ['SESSION_SECRET', config.sessionSecret],
      ...(config.authMode === 'okta'
        ? [
            ['APP_BASE_URL', config.appBaseUrl],
          ]
        : []),
      ...(config.authMode === 'iap'
        ? []
        : []),
    ].filter(([, value]) => !value);

    if (required.length) {
      throw new Error(`Missing required production settings: ${required.map(([name]) => name).join(', ')}`);
    }
  }
}
