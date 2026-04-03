import fs from 'fs';
import express from '../node_modules/express/index.js';
import { INDEX_HTML_PATH, DIST_DIR, getConfig } from './config.js';
import { resolveAccessRecord, isAccessAdmin, isAccessAuthorized, buildAccessDeniedMessage, listAccessRecords, upsertAccessRecord, deleteAccessRecord, normalizeEmail, isImmutableAdminEmail } from './access.js';
import { auditError, auditEvent } from './logging.js';
import { clearSignedCookie, makeExpiringPayload, readSignedCookie, setSignedCookie } from './session.js';
import { isIapConfigured, verifyIapRequest } from './iap.js';
import { buildAuthorizeUrl, createLoginTransaction, exchangeCode, fetchUserInfo, getDiscoveryDocument, isOktaConfigured, verifyIdToken } from './okta.js';
import { ENVIRONMENTS, registerLoadFactorRoutes, setLoadFactorRuntimeConfig } from './loadfactor-data.js';
import { getEnvironmentDecision, getPermissionSnapshot } from './permissions.js';

function sanitizeReturnTo(value) {
  const raw = String(value || '').trim();
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

function getExternalBaseUrl(req, config) {
  if (config.appBaseUrl) return config.appBaseUrl;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https')
    .split(',')[0]
    .trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim();
  return forwardedHost ? `${forwardedProto}://${forwardedHost}` : '';
}

function buildCookieOptions(config, maxAgeSeconds) {
  return {
    httpOnly: true,
    maxAge: maxAgeSeconds,
    path: '/',
    sameSite: 'Lax',
    secure: config.cookieSecure,
  };
}

function buildPublicUser(session, access = null) {
  return {
    email: session.email,
    displayName: session.displayName,
    role: access?.role || session.role || 'viewer',
    authProvider: session.authProvider || 'okta',
    isDevBypass: Boolean(session.isDevBypass),
    iapAudienceVerified: session.iap?.audienceVerified ?? null,
  };
}

function buildPermissionSummary(snapshot) {
  return {
    mode: snapshot.mode || 'checked',
    reason: snapshot.reason || null,
    checkedAt: snapshot.checkedAt,
    authorizedEnvironmentNames: snapshot.authorizedEnvironmentNames,
    environmentAccess: snapshot.environmentAccess.map((item) => ({
      environment: item.environment,
      project: item.project,
      status: item.status,
      reason: item.reason,
      checkedAt: item.checkedAt,
    })),
    projectAccess: snapshot.projectAccess,
  };
}

function buildSkippedPermissionSummary(reason = 'not_checked') {
  return {
    mode: 'skipped',
    reason,
    checkedAt: null,
    authorizedEnvironmentNames: [],
    environmentAccess: [],
    projectAccess: [],
  };
}

function getDevBypassSession(config) {
  if (!config.devAuthBypass) return null;
  return {
    sub: 'dev-bypass',
    email: config.devAuthBypassEmail,
    displayName: config.devAuthBypassName,
    role: 'admin',
    authProvider: 'dev-bypass',
    isDevBypass: true,
  };
}

function getSessionFromRequest(req, config) {
  if (config.devAuthBypass) return getDevBypassSession(config);
  if (config.authMode === 'iap') return null;
  if (!config.sessionSecret) return null;
  return readSignedCookie(req, config.sessionCookieName, config.sessionSecret);
}

function isHtmlRequest(req) {
  return !req.path.startsWith('/api') && !req.path.startsWith('/auth') && req.path !== '/healthz';
}

function sendApiUnauthorized(res) {
  res.status(401).json({
    error: 'Authentication required.',
    authenticated: false,
    authorized: false,
  });
}

function redirectToLogin(req, res) {
  const returnTo = sanitizeReturnTo(req.originalUrl || req.url || '/');
  return res.redirect(302, `/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
}

async function loadAccess(req, config) {
  if (req.accessResolved) return req.accessRecord;
  req.accessResolved = true;

  if (!req.sessionUser) {
    req.accessRecord = null;
    return null;
  }

  if (req.sessionUser.isDevBypass) {
    req.accessRecord = {
      email: req.sessionUser.email,
      role: 'admin',
      status: 'active',
      updatedBy: 'dev-bypass',
    };
    return req.accessRecord;
  }

  req.accessRecord = await resolveAccessRecord(config, req.sessionUser.email);
  return req.accessRecord;
}

async function loadPermissionSnapshot(req, config) {
  if (req.permissionSnapshot) return req.permissionSnapshot;
  if (!req.sessionUser) return null;

  req.permissionSnapshot = await getPermissionSnapshot(config, req.sessionUser.email, {
    assumeAllowed: Boolean(req.sessionUser.isDevBypass),
  });
  return req.permissionSnapshot;
}

function buildEnvPermissionDeniedResponse(sessionUser, access, decision, environment) {
  return {
    error: `You are signed in and allowlisted, but do not currently have the required Spanner permissions for ${environment}.`,
    authenticated: true,
    authorized: true,
    environmentAuthorized: false,
    user: buildPublicUser(sessionUser, access),
    access: access ? { role: access.role, status: access.status } : null,
    environmentAccess: decision
      ? {
          environment: decision.environment,
          project: decision.project,
          status: decision.status,
          reason: decision.reason,
          checkedAt: decision.checkedAt,
        }
      : {
          environment,
          status: 'unknown',
          reason: 'environment_not_evaluated',
          checkedAt: null,
        },
  };
}

async function requireAuthorizedApi(req, res, next) {
  if (!req.sessionUser) {
    return sendApiUnauthorized(res);
  }

  try {
    const access = await loadAccess(req, req.app.locals.config);
    if (!isAccessAuthorized(access)) {
      const message = buildAccessDeniedMessage(access, req.sessionUser.email);
      auditEvent('allowlist_denied', {
        email: req.sessionUser.email,
        reason: access ? `status_${access.status}` : 'missing',
        path: req.path,
      });
      return res.status(403).json({
        error: message,
        authenticated: true,
        authorized: false,
        user: buildPublicUser(req.sessionUser, access),
        access: access ? { role: access.role, status: access.status } : null,
      });
    }

    next();
  } catch (error) {
    next(error);
  }
}

function requireEnvironmentAccess(getEnvironment) {
  return async (req, res, next) => {
    if (!req.sessionUser) {
      return sendApiUnauthorized(res);
    }

    const environment = String(getEnvironment(req) || 'rx-prd').trim();
    if (!ENVIRONMENTS[environment]) {
      return next();
    }

    try {
      const config = req.app.locals.config;
      const access = await loadAccess(req, config);
      if (!isAccessAuthorized(access)) {
        return res.status(403).json({
          error: buildAccessDeniedMessage(access, req.sessionUser.email),
          authenticated: true,
          authorized: false,
          user: buildPublicUser(req.sessionUser, access),
          access: access ? { role: access.role, status: access.status } : null,
        });
      }

      const snapshot = await loadPermissionSnapshot(req, config);
      const decision = getEnvironmentDecision(snapshot, environment);
      if (decision?.status !== 'allowed') {
        auditEvent('environment_access_denied', {
          email: req.sessionUser.email,
          env: environment,
          status: decision?.status || 'unknown',
          reason: decision?.reason || 'environment_not_evaluated',
        });
        return res.status(403).json(buildEnvPermissionDeniedResponse(req.sessionUser, access, decision, environment));
      }

      req.environmentAccess = decision;
      next();
    } catch (error) {
      next(error);
    }
  };
}

async function listAuthorizedEnvironments(req) {
  const config = req.app.locals.config;
  const snapshot = await loadPermissionSnapshot(req, config);
  return snapshot.environmentAccess
    .filter((item) => item.status === 'allowed')
    .map((item) => ({
      name: item.environment,
      project: item.project,
      isProd: item.environment === 'rx-prd',
      status: item.status,
      reason: item.reason,
      checkedAt: item.checkedAt,
    }));
}

async function requireAdminApi(req, res, next) {
  if (!req.sessionUser) {
    return sendApiUnauthorized(res);
  }

  try {
    const access = await loadAccess(req, req.app.locals.config);
    if (!isAccessAdmin(access)) {
      return res.status(403).json({
        error: 'Admin access required.',
        authenticated: true,
        authorized: Boolean(isAccessAuthorized(access)),
        user: buildPublicUser(req.sessionUser, access),
        access: access ? { role: access.role, status: access.status } : null,
      });
    }

    next();
  } catch (error) {
    next(error);
  }
}

export function createApp(config = getConfig()) {
  const app = express();
  const hasBuiltClient = fs.existsSync(INDEX_HTML_PATH);

  app.locals.config = config;
  setLoadFactorRuntimeConfig({
    spannerBuiltInMetricsEnabled: config.spannerBuiltInMetricsEnabled,
  });
  app.disable('x-powered-by');
  app.use(express.json());

  app.use(async (req, _res, next) => {
    try {
      req.sessionUser = getSessionFromRequest(req, config);
      if (!req.sessionUser && config.authMode === 'iap' && isIapConfigured(config)) {
        req.sessionUser = await verifyIapRequest(req, config);
        if (req.sessionUser?.iap) {
          auditEvent('iap_identity_verified', {
            email: req.sessionUser.email,
            aud: req.sessionUser.iap.aud,
            hd: req.sessionUser.iap.hd,
            audienceVerified: req.sessionUser.iap.audienceVerified,
          });
        }
      }
      req.accessResolved = false;
      req.accessRecord = null;
      next();
    } catch (error) {
      next(error);
    }
  });

  app.get('/healthz', (_req, res) => {
    res.json({
      status: 'ok',
      service: config.serviceName,
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/auth/login', async (req, res, next) => {
    try {
      const returnTo = sanitizeReturnTo(req.query.returnTo);

      if (config.devAuthBypass) {
        const payload = makeExpiringPayload({
          sub: 'dev-bypass',
          email: config.devAuthBypassEmail,
          displayName: config.devAuthBypassName,
          authProvider: 'dev-bypass',
          isDevBypass: true,
        }, config.sessionMaxAgeSeconds);
        setSignedCookie(res, config.sessionCookieName, payload, config.sessionSecret || 'dev-bypass-secret', buildCookieOptions(config, config.sessionMaxAgeSeconds));
        return res.redirect(302, returnTo);
      }

      if (config.authMode === 'iap') {
        return res.redirect(302, returnTo);
      }

      if (!isOktaConfigured(config)) {
        throw new Error('Okta authentication is not configured.');
      }

      const discovery = await getDiscoveryDocument(config);
      const transaction = createLoginTransaction(config, returnTo);
      setSignedCookie(
        res,
        config.authStateCookieName,
        transaction,
        config.sessionSecret,
        buildCookieOptions(config, config.authStateMaxAgeSeconds),
      );

      auditEvent('auth_login_started', { returnTo });
      return res.redirect(302, buildAuthorizeUrl(config, discovery, transaction));
    } catch (error) {
      next(error);
    }
  });

  app.get('/auth/callback', async (req, res, next) => {
    try {
      if (config.authMode === 'iap') {
        return res.redirect(302, sanitizeReturnTo(req.query.returnTo || '/'));
      }

      if (!isOktaConfigured(config)) {
        throw new Error('Okta authentication is not configured.');
      }

      const { code, state, error, error_description: errorDescription } = req.query;
      const transaction = readSignedCookie(req, config.authStateCookieName, config.sessionSecret);

      if (error) {
        auditEvent('auth_callback_failed', {
          reason: String(error),
          description: String(errorDescription || ''),
        });
        return res.status(400).send(`Okta login failed: ${String(errorDescription || error)}`);
      }

      if (!transaction || !code || !state || transaction.state !== state) {
        auditEvent('auth_callback_failed', { reason: 'state_mismatch' });
        return res.status(400).send('Login callback validation failed.');
      }

      const discovery = await getDiscoveryDocument(config);
      const tokenSet = await exchangeCode(config, discovery, {
        code: String(code),
        codeVerifier: transaction.codeVerifier,
      });
      let profile = await verifyIdToken(config, discovery, tokenSet.id_token, transaction.nonce);

      if (!profile.email) {
        const userInfo = await fetchUserInfo(discovery, tokenSet.access_token);
        profile = {
          ...profile,
          email: String(userInfo.email || '').trim().toLowerCase(),
          displayName: String(userInfo.name || profile.displayName || '').trim(),
        };
      }

      if (!profile.email) {
        throw new Error('Okta profile did not include an email address.');
      }

      const sessionPayload = makeExpiringPayload({
        sub: profile.sub,
        email: profile.email,
        displayName: profile.displayName || profile.email,
        authProvider: 'okta',
      }, config.sessionMaxAgeSeconds);

      clearSignedCookie(res, config.authStateCookieName, buildCookieOptions(config, 0));
      setSignedCookie(
        res,
        config.sessionCookieName,
        sessionPayload,
        config.sessionSecret,
        buildCookieOptions(config, config.sessionMaxAgeSeconds),
      );

      auditEvent('auth_callback_succeeded', {
        email: profile.email,
        returnTo: transaction.returnTo,
      });
      return res.redirect(302, sanitizeReturnTo(transaction.returnTo));
    } catch (error) {
      next(error);
    }
  });

  app.post('/auth/logout', (req, res) => {
    if (config.authMode !== 'iap') {
      clearSignedCookie(res, config.sessionCookieName, buildCookieOptions(config, 0));
      clearSignedCookie(res, config.authStateCookieName, buildCookieOptions(config, 0));
    }
    auditEvent('auth_logout', {
      email: req.sessionUser?.email || null,
    });
    res.status(204).end();
  });

  app.get('/auth/switch-account', (req, res) => {
    const returnTo = sanitizeReturnTo(req.query.returnTo);

    if (config.authMode !== 'iap') {
      return res.redirect(302, `/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
    }

    const externalBaseUrl = getExternalBaseUrl(req, config);
    const continueUrl = externalBaseUrl ? `${externalBaseUrl}${returnTo}` : returnTo;
    const appEngineLogoutUrl = `https://appengine.google.com/_ah/logout?continue=${encodeURIComponent(continueUrl)}`;
    const googleLogoutUrl = `https://accounts.google.com/Logout?continue=${encodeURIComponent(appEngineLogoutUrl)}`;

    auditEvent('auth_switch_account', {
      email: req.sessionUser?.email || null,
      returnTo,
      continueUrl,
    });
    res.redirect(302, googleLogoutUrl);
  });

  app.get('/api/me', async (req, res, next) => {
    if (!req.sessionUser) {
      return sendApiUnauthorized(res);
    }

    try {
      const access = await loadAccess(req, config);
      const user = buildPublicUser(req.sessionUser, access);
      if (!isAccessAuthorized(access)) {
        return res.status(403).json({
          error: buildAccessDeniedMessage(access, req.sessionUser.email),
          authenticated: true,
          authorized: false,
          user,
          access: access ? { role: access.role, status: access.status } : null,
        });
      }

      const permissions = await loadPermissionSnapshot(req, config);
      const authorizedEnvironments = permissions.authorizedEnvironmentNames;

      res.json({
        authenticated: true,
        authorized: true,
        user,
        access: { role: access.role, status: access.status },
        permissions: buildPermissionSummary(permissions),
        authorizedEnvironmentCount: authorizedEnvironments.length,
        authMode: config.authMode,
      });
    } catch (error) {
      next(error);
    }
  });

  const adminApi = express.Router();
  adminApi.use(requireAdminApi);

  adminApi.get('/api/access-users', async (req, res, next) => {
    try {
      const users = await listAccessRecords(config);
      res.json({
        count: users.length,
        users,
      });
    } catch (error) {
      next(error);
    }
  });

  adminApi.get('/api/access-users/:email/permissions', async (req, res, next) => {
    try {
      const email = normalizeEmail(req.params.email);
      if (!email) {
        return res.status(400).json({ error: 'Email is required.' });
      }
      const permissions = await getPermissionSnapshot(config, email, { assumeAllowed: false });
      res.json({ email, permissions: buildPermissionSummary(permissions) });
    } catch (error) {
      next(error);
    }
  });

  adminApi.post('/api/access-users', async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const role = String(req.body?.role || 'viewer').trim().toLowerCase();
      const status = String(req.body?.status || 'active').trim().toLowerCase();

      if (!email) {
        return res.status(400).json({ error: 'Email is required.' });
      }

      if (isImmutableAdminEmail(email) && (role !== 'admin' || status !== 'active')) {
        return res.status(403).json({
          error: 'alex.zuttre@flyr.com must remain an active admin.',
        });
      }

      const record = await upsertAccessRecord(config, {
        email,
        role,
        status,
        updatedBy: req.sessionUser.email,
      });

      auditEvent('access_user_upserted', {
        actor: req.sessionUser.email,
        email: record.email,
        role: record.role,
        status: record.status,
      });

      res.status(201).json({
        message: 'Access user saved.',
        user: record,
      });
    } catch (error) {
      if (/Unsupported role|Unsupported status|Email is required/.test(error.message || '')) {
        res.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  adminApi.delete('/api/access-users/:email', async (req, res, next) => {
    try {
      const email = normalizeEmail(req.params.email);
      if (!email) {
        return res.status(400).json({ error: 'Email is required.' });
      }

      if (isImmutableAdminEmail(email)) {
        return res.status(403).json({
          error: 'alex.zuttre@flyr.com cannot be removed from the allowlist.',
        });
      }

      const result = await deleteAccessRecord(config, email);
      auditEvent('access_user_deleted', {
        actor: req.sessionUser.email,
        email: result.email,
        deleted: result.deleted,
      });

      res.json({
        message: result.deleted ? 'Access user removed.' : 'Access user not found.',
        ...result,
      });
    } catch (error) {
      next(error);
    }
  });

  app.use(adminApi);

  const protectedApi = express.Router();
  protectedApi.use(requireAuthorizedApi);
  registerLoadFactorRoutes(protectedApi, {
    requireEnvironmentAccess,
    listAuthorizedEnvironments,
  });
  app.use(protectedApi);

  if (hasBuiltClient) {
    app.use((req, res, next) => {
      if (!isHtmlRequest(req)) return next();
      if (!req.sessionUser) return redirectToLogin(req, res);
      next();
    });

    app.use(express.static(DIST_DIR, { index: false }));

    app.get(/^(?!\/api\/|\/auth\/|\/healthz$).*/, (req, res) => {
      if (!req.sessionUser) return redirectToLogin(req, res);
      res.sendFile(INDEX_HTML_PATH);
    });
  } else {
    app.get('/', (req, res) => {
      if (!req.sessionUser) return redirectToLogin(req, res);
      res.status(503).send('Client build not found. Run `npm run build` or use `npm run dev` locally.');
    });
  }

  app.use((error, req, res, _next) => {
    auditError('request_failed', error, { path: req.path, method: req.method });
    if (res.headersSent) return;
    if (config.authMode === 'iap' && error.code === 'IAP_AUTH_ERROR') {
      if (req.path.startsWith('/api/')) {
        res.status(401).json({ error: 'IAP authentication required.' });
        return;
      }
      res.status(401).send('IAP authentication required.');
      return;
    }
    if (req.path.startsWith('/api/')) {
      res.status(500).json({ error: 'Internal server error.' });
      return;
    }
    res.status(500).send('Internal server error.');
  });

  return app;
}
