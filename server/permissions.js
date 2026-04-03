import { GoogleAuth } from '../node_modules/google-auth-library/build/src/index.js';
import { auditError, auditEvent } from './logging.js';
import { normalizeEmail } from './access.js';
import { ENVIRONMENTS, buildEnvironmentPermissionTargets } from './loadfactor-data.js';

const CLOUD_ASSET_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const REQUIRED_PERMISSIONS = ['spanner.sessions.create'];
const ACCESS_CACHE = new Map();
const AVAILABILITY_CACHE = new Map();
const DEFAULT_CHECK_CONCURRENCY = 4;

let authClientPromise = null;

function getAuthClient() {
  if (!authClientPromise) {
    const auth = new GoogleAuth({ scopes: [CLOUD_ASSET_SCOPE] });
    authClientPromise = auth.getClient();
  }
  return authClientPromise;
}

function nowIso() {
  return new Date().toISOString();
}

function getCacheKey(config, email) {
  return `${config.gcpOrganizationId || '__default__'}:${normalizeEmail(email)}`;
}

function createLimiter(limit = DEFAULT_CHECK_CONCURRENCY) {
  let active = 0;
  const queue = [];

  const runNext = () => {
    if (active >= limit || !queue.length) return;
    const { task, resolve, reject } = queue.shift();
    active += 1;
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        runNext();
      });
  };

  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    runNext();
  });
}

function getStockkeeperResource(envName) {
  const targets = buildEnvironmentPermissionTargets(envName);
  return targets.find((t) => t.key === 'stockkeeper') || targets[0];
}

async function analyzeIamPermission(config, principalEmail, fullResourceName) {
  const orgId = config.gcpOrganizationId;
  if (!orgId) {
    throw new Error('GCP_ORGANIZATION_ID is required for permission checks');
  }

  const scope = `organizations/${orgId}`;
  const url = new URL(`https://cloudasset.googleapis.com/v1/${scope}:analyzeIamPolicy`);
  url.searchParams.set('analysisQuery.identitySelector.identity', `user:${principalEmail}`);
  url.searchParams.set('analysisQuery.accessSelector.permissions', REQUIRED_PERMISSIONS[0]);
  url.searchParams.set('analysisQuery.resourceSelector.fullResourceName', fullResourceName);

  const client = await getAuthClient();
  const accessToken = await client.getAccessToken();
  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${typeof accessToken === 'string' ? accessToken : accessToken?.token || ''}`,
      ...(config.googleCloudProject
        ? { 'x-goog-user-project': config.googleCloudProject }
        : {}),
    },
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(errorBody || `Cloud Asset API request failed with HTTP ${response.status}`);
  }

  return await response.json();
}

function classifyAssetApiError(error) {
  const message = String(error?.message || '');
  if (message.includes('has not been used in project') || message.includes('is disabled')) {
    return { code: 'api_disabled', reason: 'cloud_asset_api_disabled', message };
  }
  if (message.includes('PERMISSION_DENIED') || message.includes('does not have')) {
    return { code: 'permission_denied', reason: 'cloud_asset_permission_denied', message };
  }
  if (message.includes('ECONNRESET') || message.includes('ETIMEDOUT') || message.includes('ENOTFOUND') || message.includes('socket hang up')) {
    return { code: 'network_error', reason: 'cloud_asset_network_error', message };
  }
  return { code: 'unknown_error', reason: 'cloud_asset_error', message };
}

async function probeAvailability(config, principalEmail) {
  const cacheKey = config.gcpOrganizationId || '__default__';
  const cached = AVAILABILITY_CACHE.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const probeResource = getStockkeeperResource('rx-prd');
  try {
    await analyzeIamPermission(config, principalEmail, probeResource.fullResourceName);
    const value = { available: true, checkedAt: nowIso() };
    AVAILABILITY_CACHE.set(cacheKey, { expiresAt: Date.now() + config.permissionCacheTtlMs, value });
    return value;
  } catch (error) {
    const classified = classifyAssetApiError(error);
    auditError('permission_probe_failed', error, {
      email: principalEmail,
      orgId: config.gcpOrganizationId || null,
      code: classified.code,
    });
    const value = { available: false, checkedAt: nowIso(), ...classified };
    AVAILABILITY_CACHE.set(cacheKey, { expiresAt: Date.now() + config.permissionCacheTtlMs, value });
    return value;
  }
}

function interpretAnalysisResult(data) {
  const main = data.mainAnalysis || data;
  const results = main.analysisResults || [];
  const fullyExplored = main.fullyExplored;

  if (results.length > 0) {
    return { status: 'allowed', reason: 'permission_granted' };
  }
  if (fullyExplored === true) {
    return { status: 'denied', reason: 'permission_not_granted' };
  }
  return { status: 'unknown', reason: 'incomplete_analysis' };
}

async function evaluateEnvironmentAccess(config, principalEmail, environment) {
  const cfg = ENVIRONMENTS[environment];
  const checkedAt = nowIso();
  const resource = getStockkeeperResource(environment);

  try {
    const data = await analyzeIamPermission(config, principalEmail, resource.fullResourceName);
    const result = interpretAnalysisResult(data);
    return {
      environment,
      project: cfg.project,
      status: result.status,
      reason: result.reason,
      checkedAt,
    };
  } catch (error) {
    const classified = classifyAssetApiError(error);
    auditError('permission_check_failed', error, {
      email: principalEmail,
      environment,
      resource: resource.fullResourceName,
      code: classified.code,
    });
    return {
      environment,
      project: cfg.project,
      status: 'unknown',
      reason: classified.reason,
      checkedAt,
    };
  }
}

function buildProjectAccess(environmentAccess) {
  const grouped = new Map();

  for (const env of environmentAccess) {
    if (!grouped.has(env.project)) {
      grouped.set(env.project, { project: env.project, environments: [] });
    }
    grouped.get(env.project).environments.push({
      environment: env.environment,
      status: env.status,
      reason: env.reason,
      checkedAt: env.checkedAt,
    });
  }

  return [...grouped.values()]
    .map((project) => {
      project.environments.sort((a, b) => a.environment.localeCompare(b.environment));
      return project;
    })
    .sort((a, b) => a.project.localeCompare(b.project));
}

function buildSnapshot(principalEmail, environmentAccess, checkedAt) {
  const authorizedEnvironmentNames = environmentAccess
    .filter((item) => item.status === 'allowed')
    .map((item) => item.environment);

  return {
    principalEmail,
    checkedAt,
    authorizedEnvironmentNames,
    environmentAccess,
    projectAccess: buildProjectAccess(environmentAccess),
  };
}

function buildAllowedSnapshot(email) {
  const principalEmail = normalizeEmail(email);
  const checkedAt = nowIso();
  const environmentAccess = Object.entries(ENVIRONMENTS).map(([environment, cfg]) => ({
    environment,
    project: cfg.project,
    status: 'allowed',
    reason: 'dev_bypass',
    checkedAt,
  }));
  return buildSnapshot(principalEmail, environmentAccess, checkedAt);
}

function buildUnavailableSnapshot(principalEmail, checkedAt, reason) {
  const environmentAccess = Object.entries(ENVIRONMENTS).map(([environment, cfg]) => ({
    environment,
    project: cfg.project,
    status: 'unknown',
    reason,
    checkedAt,
  }));
  return buildSnapshot(principalEmail, environmentAccess, checkedAt);
}

export async function getPermissionSnapshot(config, email, options = {}) {
  const principalEmail = normalizeEmail(email);
  if (!principalEmail) {
    return buildSnapshot('', [], nowIso());
  }

  if (options.assumeAllowed) {
    return buildAllowedSnapshot(principalEmail);
  }

  const cacheTtlMs = config.permissionCacheTtlMs;
  const cacheKey = getCacheKey(config, principalEmail);
  const cached = ACCESS_CACHE.get(cacheKey);
  if (!options.forceRefresh && cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const checkedAt = nowIso();
  const availability = await probeAvailability(config, principalEmail);
  if (!availability.available) {
    const snapshot = buildUnavailableSnapshot(principalEmail, checkedAt, availability.reason);
    ACCESS_CACHE.set(cacheKey, { expiresAt: Date.now() + cacheTtlMs, value: snapshot });
    auditEvent('permission_snapshot_unavailable', {
      email: principalEmail,
      reason: availability.reason,
      checkedAt,
    });
    return snapshot;
  }

  const limit = createLimiter(DEFAULT_CHECK_CONCURRENCY);
  const environmentAccess = await Promise.all(
    Object.keys(ENVIRONMENTS).map((environment) => limit(() => evaluateEnvironmentAccess(config, principalEmail, environment))),
  );
  const snapshot = buildSnapshot(principalEmail, environmentAccess, checkedAt);

  ACCESS_CACHE.set(cacheKey, { expiresAt: Date.now() + cacheTtlMs, value: snapshot });

  auditEvent('permission_snapshot_refreshed', {
    email: principalEmail,
    authorizedEnvironmentCount: snapshot.authorizedEnvironmentNames.length,
    checkedAt,
  });

  return snapshot;
}

export function getEnvironmentDecision(snapshot, environment) {
  return snapshot?.environmentAccess?.find((item) => item.environment === environment) || null;
}

export function summarizeEnvironmentDecision(decision) {
  if (!decision) {
    return { status: 'unknown', reason: 'environment_not_evaluated' };
  }
  return { status: decision.status, reason: decision.reason };
}

export function clearPermissionCache() {
  ACCESS_CACHE.clear();
  AVAILABILITY_CACHE.clear();
}

export { REQUIRED_PERMISSIONS };
