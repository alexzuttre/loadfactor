import { Spanner } from '@google-cloud/spanner';
import { auditError, auditEvent } from './logging.js';

export const ENVIRONMENTS = {
  'rx-int':      { project: 'prj-rx-int-ooms-a557', skInstance: 'stockkeeper-euw3-int',      region: 'euw3' },
  'rx-qa':       { project: 'prj-rx-int-ooms-a557', skInstance: 'stockkeeper-euw3-qa',       region: 'euw3' },
  'rx-testing':  { project: 'prj-rx-stg-ooms-a729', skInstance: 'stockkeeper-euw3-testing',  region: 'euw3' },
  'rx-training': { project: 'prj-rx-stg-ooms-a729', skInstance: 'stockkeeper-mec2-training', region: 'mec2' },
  'rx-nft':      { project: 'prj-rx-stg-ooms-a729', skInstance: 'stockkeeper-mec2-nft',      region: 'mec2' },
  'rx-prd':      { project: 'prj-rx-prd-ooms-6f6c', skInstance: 'stockkeeper-mec2-prd',      region: 'mec2' },
};

const QUERY_TIMEOUT_MS = 300_000;
const spannerClientCache = new Map();
const aircraftDetailsCache = new Map();
const seatMapNameCache = new Map();
const seatMapCacheRefreshes = new Map();
const AIRCRAFT_CACHE_TTL_MS = 10 * 60 * 1000;
const SEAT_MAP_CACHE_TTL_MS = 60 * 60 * 1000;

const TRACKER_SERVICE_SQL = `
SELECT
  ts.tracker_id,
  MIN(ts.service_instance_id) AS service_instance_id
FROM trackers_services ts
JOIN services se
  ON ts.service_instance_id = se.id
LEFT JOIN segments seg
  ON se.segment_id = seg.segment_id
WHERE ts.tracker_id IN UNNEST(@trackerIds)
  AND ts.deleted_at IS NULL
  AND se.deleted_at IS NULL
  AND COALESCE(seg.frozen, FALSE) = FALSE
GROUP BY ts.tracker_id
`;

const AIRCRAFT_TYPE_SQL = `
WITH resolved_aircraft AS (
  SELECT
    si.service_instance_id,
    ARRAY_AGG(
      IF(
        COALESCE(
          sl_direct.aircraft_type,
          sl_quota.aircraft_type,
          sl_direct.seat_map_id,
          sl_quota.seat_map_id
        ) IS NULL,
        NULL,
        STRUCT(
          COALESCE(sl_direct.aircraft_type, sl_quota.aircraft_type) AS aircraft_type,
          COALESCE(sl_direct.seat_map_id, sl_quota.seat_map_id) AS seat_map_id,
          COALESCE(sl_direct.seat_map_version, sl_quota.seat_map_version) AS seat_map_version
        )
      )
      IGNORE NULLS
      LIMIT 1
    )[SAFE_OFFSET(0)] AS details
  FROM service_instances si
  LEFT JOIN segment_legs sl_direct
    ON si.attachment_id = sl_direct.segment_id
   AND si.attachment_version = sl_direct.segment_version
  LEFT JOIN service_instance_quotas siq
    ON si.service_instance_id = siq.service_instance_id
  LEFT JOIN quotas q
    ON siq.quota_id = q.quota_id
  LEFT JOIN segment_legs sl_quota
    ON q.context_type = 'LEG_CABIN'
   AND q.context_id = sl_quota.leg_id
   AND q.context_version <= sl_quota.version
  WHERE si.service_instance_id IN UNNEST(@serviceInstanceIds)
    AND si.attachment_type IN UNNEST(['SEGMENT', 'SEGMENT_SEAT_MAP'])
  GROUP BY si.service_instance_id
)
SELECT
  ra.service_instance_id,
  ra.details.aircraft_type AS aircraft_type,
  ra.details.seat_map_id AS seat_map_id,
  ra.details.seat_map_version AS seat_map_version
FROM resolved_aircraft ra
`;

const SEAT_MAP_NAME_SQL = `
SELECT
  seat_map_id,
  seat_map_version,
  name
FROM seat_maps
WHERE name IS NOT NULL
`;

function withTimeout(promise, ms = QUERY_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`DEADLINE_EXCEEDED: query timed out after ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function getSpannerClients(envName) {
  if (spannerClientCache.has(envName)) return spannerClientCache.get(envName);

  const env = ENVIRONMENTS[envName];
  if (!env) throw new Error(`Unknown environment: ${envName}`);

  const spanner = new Spanner({
    projectId: env.project,
    clientConfig: { quota_project_id: env.project },
  });
  const skDatabase = spanner.instance(env.skInstance).database('stockkeeper');
  const pcInstanceName = `productcatalog-${env.region}-${envName.replace('rx-', '')}`;
  const pcDatabase = spanner.instance(pcInstanceName).database('productcatalog-search');

  const clients = { skDatabase, pcDatabase, project: env.project };
  spannerClientCache.set(envName, clients);
  return clients;
}

function buildLoadFactorStatement({ dateFrom, dateTo, origin, destination, cabinCodes, flightFilters }) {
  const params = {
    carrier: 'RX',
    dateFrom,
    dateTo,
    origin,
    destination,
    cabinCodes,
  };
  const types = {
    carrier: { type: 'string' },
    dateFrom: { type: 'date' },
    dateTo: { type: 'date' },
    origin: { type: 'string' },
    destination: { type: 'string' },
    cabinCodes: { type: 'array', child: { type: 'int64' } },
  };

  const flightClause = flightFilters.length
    ? `\n    AND (${flightFilters.map(({ start, end }, index) => {
        const startKey = `flightStart${index}`;
        const endKey = `flightEnd${index}`;
        params[startKey] = start;
        params[endKey] = end;
        types[startKey] = { type: 'int64' };
        types[endKey] = { type: 'int64' };
        return `SAFE_CAST(tr.operating_flight_number AS INT64) BETWEEN @${startKey} AND @${endKey}`;
      }).join(' OR ')})`
    : '';

  const sql = `
SELECT
  tr.id AS tracker_id,
  tr.departure_date,
  tr.origin,
  tr.destination,
  tr.operating_carrier_code,
  tr.operating_flight_number,
  tr.operational_suffix,
  tr.cabin_code,
  CASE tr.cabin_code
    WHEN 2 THEN 'Business'
    WHEN 4 THEN 'Premium Economy'
    WHEN 5 THEN 'Economy'
    ELSE CONCAT('Cabin ', CAST(tr.cabin_code AS STRING))
  END AS cabin_name,
  CAST(JSON_VALUE(tr.quota, '$.physicalCapacity') AS INT64) AS physical_capacity,
  tr.lidded_capacity,
  tr.sellable_capacity,
  tr.sold,
  tr.held,
  tr.available,
  CASE
    WHEN tr.sellable_capacity = 0
      AND CAST(JSON_VALUE(tr.adjustments_meta, '$.sellableCapacityAdjustmentTimestamp') AS TIMESTAMP) IS NOT NULL
      AND (
        tr.bid_price_event_timestamp IS NULL
        OR CAST(JSON_VALUE(tr.adjustments_meta, '$.sellableCapacityAdjustmentTimestamp') AS TIMESTAMP) >= tr.bid_price_event_timestamp
      )
    THEN CAST(NULL AS TIMESTAMP)
    WHEN CAST(JSON_VALUE(tr.adjustments_meta, '$.sellableCapacityAdjustmentTimestamp') AS TIMESTAMP) >= COALESCE(tr.bid_price_event_timestamp, TIMESTAMP '2000-01-01 00:00:00+00')
    THEN CAST(JSON_VALUE(tr.adjustments_meta, '$.sellableCapacityAdjustmentTimestamp') AS TIMESTAMP)
    WHEN tr.sellable_capacity_opt IS NOT NULL
    THEN tr.bid_price_event_timestamp
    ELSE NULL
  END AS sellable_last_updated_at,
  CASE
    WHEN tr.sellable_capacity = 0
      AND CAST(JSON_VALUE(tr.adjustments_meta, '$.sellableCapacityAdjustmentTimestamp') AS TIMESTAMP) IS NOT NULL
      AND (
        tr.bid_price_event_timestamp IS NULL
        OR CAST(JSON_VALUE(tr.adjustments_meta, '$.sellableCapacityAdjustmentTimestamp') AS TIMESTAMP) >= tr.bid_price_event_timestamp
      )
    THEN 'unknown (non-sellable adj.)'
    WHEN CAST(JSON_VALUE(tr.adjustments_meta, '$.sellableCapacityAdjustmentTimestamp') AS TIMESTAMP) >= COALESCE(tr.bid_price_event_timestamp, TIMESTAMP '2000-01-01 00:00:00+00')
    THEN 'Manual Adjustment'
    WHEN tr.sellable_capacity_opt IS NOT NULL
    THEN 'Sabre / BP'
    ELSE NULL
  END AS sellable_update_source,
  tr.updated_at AS quota_last_updated_at
FROM trackers tr
WHERE tr.quota_type = 'CAPACITY'
  AND tr.operating_carrier_code = @carrier
  AND tr.deleted_at IS NULL
  AND tr.departure_date BETWEEN @dateFrom AND @dateTo
  AND (@origin = '' OR tr.origin = @origin)
  AND (@destination = '' OR tr.destination = @destination)
  AND tr.cabin_code IN UNNEST(@cabinCodes)${flightClause}
ORDER BY tr.departure_date, tr.origin, tr.destination, tr.operating_flight_number, tr.cabin_code
`;

  return { sql, params, types };
}

function intVal(value) {
  if (value == null) return null;
  if (typeof value === 'object' && 'value' in value) return Number(value.value);
  return Number(value);
}

function tsVal(value) {
  if (value == null) return null;
  if (typeof value === 'object' && 'value' in value) return value.value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function parseFlightFilters(input) {
  if (!input || !String(input).trim()) return [];

  return String(input)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const rangeMatch = part.match(/^(\d{1,4})\s*-\s*(\d{1,4})$/);
      if (rangeMatch) {
        const start = Number(rangeMatch[1]);
        const end = Number(rangeMatch[2]);
        if (start > end) throw new Error(`Invalid flight range "${part}". Start must be less than or equal to end.`);
        return { start, end };
      }

      const singleMatch = part.match(/^\d{1,4}$/);
      if (singleMatch) {
        const flight = Number(part);
        return { start: flight, end: flight };
      }

      throw new Error(`Invalid flights filter "${part}". Use values like 401,402,9991-9993.`);
    });
}

function getAircraftCacheForEnv(env) {
  if (!aircraftDetailsCache.has(env)) {
    aircraftDetailsCache.set(env, new Map());
  }
  return aircraftDetailsCache.get(env);
}

function getCachedAircraftDetails(env, serviceInstanceIds) {
  const cache = getAircraftCacheForEnv(env);
  const now = Date.now();
  const detailsMap = new Map();
  const missingIds = [];

  for (const id of serviceInstanceIds) {
    const cached = cache.get(id);
    if (cached && cached.expiresAt > now) {
      detailsMap.set(id, cached.value);
      continue;
    }
    if (cached) cache.delete(id);
    missingIds.push(id);
  }

  return { detailsMap, missingIds };
}

function setCachedAircraftDetails(env, detailsMap) {
  const cache = getAircraftCacheForEnv(env);
  const expiresAt = Date.now() + AIRCRAFT_CACHE_TTL_MS;
  for (const [id, details] of detailsMap) {
    cache.set(id, { value: details, expiresAt });
  }
}

function seatMapCacheKey(seatMapId, seatMapVersion) {
  return `${seatMapId}::${seatMapVersion}`;
}

function getSeatMapCacheEntry(env) {
  return seatMapNameCache.get(env);
}

function isSeatMapCacheFresh(env) {
  const cacheEntry = getSeatMapCacheEntry(env);
  return Boolean(cacheEntry && cacheEntry.expiresAt > Date.now());
}

function getSeatMapNameFromCache(env, seatMapId, seatMapVersion) {
  if (!seatMapId || seatMapVersion == null) return null;
  const cacheEntry = getSeatMapCacheEntry(env);
  return cacheEntry?.values.get(seatMapCacheKey(seatMapId, seatMapVersion)) ?? null;
}

async function refreshSeatMapNameCache(env, pcDatabase) {
  if (seatMapCacheRefreshes.has(env)) {
    return seatMapCacheRefreshes.get(env);
  }

  const refreshPromise = (async () => {
    const refreshStart = Date.now();
    const [rows] = await withTimeout(pcDatabase.run({ sql: SEAT_MAP_NAME_SQL }));
    const values = new Map();

    for (const row of rows) {
      const record = row.toJSON();
      if (!record.seat_map_id || record.seat_map_version == null || !record.name) continue;
      values.set(seatMapCacheKey(record.seat_map_id, record.seat_map_version), record.name);
    }

    seatMapNameCache.set(env, {
      values,
      expiresAt: Date.now() + SEAT_MAP_CACHE_TTL_MS,
      refreshedAt: Date.now(),
    });

    auditEvent('seat_map_cache_refreshed', {
      env,
      count: values.size,
      durationMs: Date.now() - refreshStart,
    });
    return values;
  })();

  seatMapCacheRefreshes.set(env, refreshPromise);
  return refreshPromise.finally(() => {
    seatMapCacheRefreshes.delete(env);
  });
}

async function ensureSeatMapNameCache(env, pcDatabase, { allowStale = true } = {}) {
  const cacheEntry = getSeatMapCacheEntry(env);

  if (cacheEntry && cacheEntry.expiresAt > Date.now()) {
    return cacheEntry.values;
  }

  if (cacheEntry?.values?.size && allowStale) {
    refreshSeatMapNameCache(env, pcDatabase).catch((error) => {
      auditError('seat_map_cache_refresh_error', error, { env });
    });
    return cacheEntry.values;
  }

  return refreshSeatMapNameCache(env, pcDatabase);
}

async function fetchServiceInstancesForTrackers(trackerIds, skDatabase) {
  const [rows] = await withTimeout(skDatabase.run({
    sql: TRACKER_SERVICE_SQL,
    params: { trackerIds },
    types: {
      trackerIds: { type: 'array', child: { type: 'string' } },
    },
  }));

  return new Map(rows.map((row) => {
    const record = row.toJSON();
    return [record.tracker_id, record.service_instance_id];
  }));
}

async function fetchAircraftDetails(serviceInstanceIds, pcDatabase, env) {
  await ensureSeatMapNameCache(env, pcDatabase);
  const [rows] = await withTimeout(pcDatabase.run({
    sql: AIRCRAFT_TYPE_SQL,
    params: { serviceInstanceIds },
    types: {
      serviceInstanceIds: { type: 'array', child: { type: 'string' } },
    },
  }));

  return new Map(rows.map((row) => {
    const record = row.toJSON();
    return [record.service_instance_id, {
      aircraft_type: record.aircraft_type ?? null,
      seat_map_id: record.seat_map_id ?? null,
      seat_map_name: record.seat_map_id && record.seat_map_version != null
        ? getSeatMapNameFromCache(env, record.seat_map_id, record.seat_map_version)
        : null,
    }];
  }));
}

export function registerLoadFactorRoutes(router) {
  router.get('/api/loadfactor', async (req, res) => {
    const { dateFrom, dateTo, origin = '', destination = '', cabins = '', flights = '', env = 'rx-prd' } = req.query;

    if (!ENVIRONMENTS[env]) {
      return res.status(400).json({ error: `Unknown environment: ${env}. Valid: ${Object.keys(ENVIRONMENTS).join(', ')}` });
    }

    if (!dateFrom || !dateTo) {
      return res.status(400).json({ error: 'dateFrom and dateTo are required.' });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      return res.status(400).json({ error: 'Dates must be in YYYY-MM-DD format.' });
    }

    if (origin && !/^[A-Z]{3}$/.test(origin.toUpperCase())) {
      return res.status(400).json({ error: 'Origin must be a 3-letter IATA code.' });
    }
    if (destination && !/^[A-Z]{3}$/.test(destination.toUpperCase())) {
      return res.status(400).json({ error: 'Destination must be a 3-letter IATA code.' });
    }

    let cabinCodes = [2, 4, 5];
    if (cabins) {
      cabinCodes = cabins.split(',').map(Number).filter((value) => [2, 4, 5].includes(value));
      if (cabinCodes.length === 0) cabinCodes = [2, 4, 5];
    }

    let flightFilters = [];
    try {
      flightFilters = parseFlightFilters(flights);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const requestStart = Date.now();
    auditEvent('loadfactor_query_started', {
      env,
      dateFrom,
      dateTo,
      cabinCodes,
      flightFilterCount: flightFilters.length,
    });

    let skDatabase;
    try {
      ({ skDatabase } = getSpannerClients(env));
    } catch (error) {
      return res.status(500).json({ error: `Failed to connect to environment ${env}.`, details: error.message });
    }

    try {
      const statement = buildLoadFactorStatement({
        dateFrom,
        dateTo,
        origin: origin ? origin.toUpperCase() : '',
        destination: destination ? destination.toUpperCase() : '',
        cabinCodes,
        flightFilters,
      });
      const queryStart = Date.now();
      const [rows] = await withTimeout(skDatabase.run(statement));
      const queryMs = Date.now() - queryStart;

      const results = rows.map((row) => {
        const record = row.toJSON();
        return {
          tracker_id: record.tracker_id ?? null,
          service_instance_id: null,
          departure_date: record.departure_date?.value ?? record.departure_date ?? null,
          origin: record.origin,
          destination: record.destination,
          operating_carrier_code: record.operating_carrier_code,
          operating_flight_number: record.operating_flight_number,
          operational_suffix: record.operational_suffix ?? null,
          aircraft_type: null,
          seat_map_id: null,
          seat_map_name: null,
          cabin_code: intVal(record.cabin_code),
          cabin_name: record.cabin_name,
          physical_capacity: intVal(record.physical_capacity),
          lidded_capacity: intVal(record.lidded_capacity),
          sellable_capacity: intVal(record.sellable_capacity),
          sold: intVal(record.sold),
          held: intVal(record.held),
          available: intVal(record.available),
          sellable_update_source: record.sellable_update_source ?? null,
          sellable_last_updated_at: tsVal(record.sellable_last_updated_at),
          quota_last_updated_at: tsVal(record.quota_last_updated_at),
        };
      });

      auditEvent('loadfactor_query_completed', {
        env,
        rowCount: results.length,
        durationMs: Date.now() - requestStart,
        skMs: queryMs,
        flightFilterCount: flightFilters.length,
      });

      res.json({
        count: results.length,
        dateFrom,
        dateTo,
        origin: origin ? origin.toUpperCase() : 'ALL',
        destination: destination ? destination.toUpperCase() : 'ALL',
        timings: { skMs: queryMs },
        results,
      });
    } catch (error) {
      auditError('loadfactor_query_failed', error, { env });
      const isTimeout = error.code === 4 || error.message?.includes('DEADLINE_EXCEEDED') || error.message?.includes('timeout');
      const message = isTimeout
        ? `Query timed out on ${env}. The environment may be unreachable or your credentials may lack access.`
        : 'Failed to query Spanner.';
      res.status(isTimeout ? 504 : 500).json({ error: message, details: error.message });
    }
  });

  router.post('/api/aircraft', async (req, res) => {
    const { trackerIds = [], serviceInstanceIds = [], env = 'rx-prd' } = req.body;

    if (!ENVIRONMENTS[env]) {
      return res.status(400).json({ error: `Unknown environment: ${env}` });
    }

    const requestedTrackerIds = trackerIds.filter(Boolean);
    const requestedServiceIds = serviceInstanceIds.filter(Boolean);
    if (!requestedTrackerIds.length && !requestedServiceIds.length) return res.json({});

    try {
      const { skDatabase, pcDatabase } = getSpannerClients(env);

      if (requestedTrackerIds.length) {
        const { detailsMap, missingIds } = getCachedAircraftDetails(env, requestedTrackerIds);

        if (missingIds.length) {
          const mappingStart = Date.now();
          const trackerToService = await withTimeout(fetchServiceInstancesForTrackers(missingIds, skDatabase));
          const mappingMs = Date.now() - mappingStart;

          const serviceIdsToFetch = [...new Set([...trackerToService.values()].filter(Boolean))];
          const pcQueryStart = Date.now();
          const fetchedByServiceId = serviceIdsToFetch.length
            ? await withTimeout(fetchAircraftDetails(serviceIdsToFetch, pcDatabase, env))
            : new Map();
          const pcQueryMs = Date.now() - pcQueryStart;

          const fetchedByTrackerId = new Map();
          for (const trackerId of missingIds) {
            const serviceId = trackerToService.get(trackerId);
            fetchedByTrackerId.set(trackerId, fetchedByServiceId.get(serviceId) ?? {
              aircraft_type: null,
              seat_map_id: null,
              seat_map_name: null,
            });
          }

          setCachedAircraftDetails(env, fetchedByTrackerId);
          for (const [trackerId, details] of fetchedByTrackerId) {
            detailsMap.set(trackerId, details);
          }

          auditEvent('aircraft_enrichment_completed', {
            env,
            requestedCount: requestedTrackerIds.length,
            queriedCount: missingIds.length,
            cacheHits: requestedTrackerIds.length - missingIds.length,
            trackerMapMs: mappingMs,
            pcQueryMs,
          });
        }

        return res.json(Object.fromEntries(detailsMap));
      }

      const { detailsMap, missingIds } = getCachedAircraftDetails(env, requestedServiceIds);
      if (missingIds.length) {
        const pcQueryStart = Date.now();
        const fetchedDetailsMap = await withTimeout(fetchAircraftDetails(missingIds, pcDatabase, env));
        const pcQueryMs = Date.now() - pcQueryStart;
        setCachedAircraftDetails(env, fetchedDetailsMap);
        for (const [id, details] of fetchedDetailsMap) {
          detailsMap.set(id, details);
        }

        auditEvent('aircraft_enrichment_completed', {
          env,
          requestedCount: requestedServiceIds.length,
          queriedCount: missingIds.length,
          cacheHits: requestedServiceIds.length - missingIds.length,
          pcQueryMs,
        });
      }

      res.json(Object.fromEntries(detailsMap));
    } catch (error) {
      auditError('aircraft_query_failed', error, { env });
      res.status(500).json({ error: 'Failed to fetch aircraft details.', details: error.message });
    }
  });

  router.post('/api/seatmaps/prewarm', async (req, res) => {
    const { env = 'rx-prd' } = req.body;

    if (!ENVIRONMENTS[env]) {
      return res.status(400).json({ error: `Unknown environment: ${env}` });
    }

    try {
      const { pcDatabase } = getSpannerClients(env);
      const wasFresh = isSeatMapCacheFresh(env);
      const cacheValues = await ensureSeatMapNameCache(env, pcDatabase, { allowStale: false });

      res.json({
        env,
        status: wasFresh ? 'fresh' : 'refreshed',
        count: cacheValues.size,
        ttlMs: SEAT_MAP_CACHE_TTL_MS,
      });
    } catch (error) {
      auditError('seatmap_prewarm_failed', error, { env });
      res.status(500).json({ error: 'Failed to prewarm seat maps.', details: error.message });
    }
  });

  // ── Dashboard endpoint ─────────────────────────────────────────────────
  const dashboardCache = new Map();
  const DASHBOARD_CACHE_TTL_MS = 60_000;
  const CABIN_LETTER = { 2: 'J', 4: 'W', 5: 'Y' };

  router.get('/api/dashboard', async (req, res) => {
    const env = req.query.env || 'rx-prd';
    const period = req.query.period || 'last3';
    if (!ENVIRONMENTS[env]) {
      return res.status(400).json({ error: `Unknown environment: ${env}` });
    }
    if (!['last3', 'next7', 'next30'].includes(period)) {
      return res.status(400).json({ error: `Unknown period: ${period}` });
    }

    // Check cache (keyed by env + period)
    const cacheKey = `${env}:${period}`;
    const cached = dashboardCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return res.json({ ...cached.data, cached: true });
    }

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    let dateFrom, dateTo;
    if (period === 'last3') {
      dateTo = today;
      dateFrom = new Date(now.getTime() - 2 * 86400000).toISOString().slice(0, 10);
    } else if (period === 'next7') {
      dateFrom = today;
      dateTo = new Date(now.getTime() + 6 * 86400000).toISOString().slice(0, 10);
    } else {
      dateFrom = today;
      dateTo = new Date(now.getTime() + 29 * 86400000).toISOString().slice(0, 10);
    }

    const sql = `
SELECT
  tr.departure_date,
  tr.cabin_code,
  tr.origin,
  tr.destination,
  tr.operating_flight_number,
  tr.operational_suffix,
  tr.sold,
  tr.held,
  tr.lidded_capacity,
  tr.sellable_capacity
FROM trackers tr
WHERE tr.quota_type = 'CAPACITY'
  AND tr.operating_carrier_code = @carrier
  AND tr.deleted_at IS NULL
  AND tr.departure_date BETWEEN @dateFrom AND @dateTo
  AND tr.cabin_code IN UNNEST(@cabinCodes)
`;

    try {
      const t0 = Date.now();
      const { skDatabase } = getSpannerClients(env);
      const [rows] = await withTimeout(skDatabase.run({
        sql,
        params: { carrier: 'RX', dateFrom, dateTo, cabinCodes: [2, 4, 5] },
        types: {
          carrier: { type: 'string' },
          dateFrom: { type: 'string' },
          dateTo: { type: 'string' },
          cabinCodes: { type: 'array', child: { type: 'int64' } },
        },
        json: true,
        jsonOptions: { wrapNumbers: false },
      }));
      const queryMs = Date.now() - t0;

      // Single-pass aggregation
      const dailyMap = new Map();       // date -> cabinCode -> {sold, lidded}
      const routeMap = new Map();       // "ORG-DST" -> {sold, lidded, flightSet, origin, destination}
      const cabinTotals = new Map();    // cabinCode -> totalSold
      const alertsHigh = [];
      const alertsLow = [];
      const alertsOverbooking = [];
      const alertsOverbookingLidded = [];
      const flightSet = new Set();      // unique flight keys

      for (const r of rows) {
        const rawDate = r.departure_date;
        const date = typeof rawDate === 'string' ? rawDate : (rawDate?.value ?? (typeof rawDate?.toJSON === 'function' ? rawDate.toJSON() : String(rawDate)));
        const cc = r.cabin_code;
        const sold = intVal(r.sold) || 0;
        const held = intVal(r.held) || 0;
        const lidded = intVal(r.lidded_capacity) || 0;
        const sellable = intVal(r.sellable_capacity) || 0;
        const flightKey = `${date}|${r.origin}|${r.destination}|${r.operating_flight_number}|${r.operational_suffix || ''}`;

        // Daily by cabin
        if (!dailyMap.has(date)) dailyMap.set(date, new Map());
        const dayMap = dailyMap.get(date);
        if (!dayMap.has(cc)) dayMap.set(cc, { sold: 0, lidded: 0 });
        const dc = dayMap.get(cc);
        dc.sold += sold;
        dc.lidded += lidded;

        // Route aggregation
        const routeKey = `${r.origin}-${r.destination}`;
        if (!routeMap.has(routeKey)) routeMap.set(routeKey, { sold: 0, lidded: 0, flights: new Set(), origin: r.origin, destination: r.destination });
        const rt = routeMap.get(routeKey);
        rt.sold += sold;
        rt.lidded += lidded;
        rt.flights.add(flightKey);

        // Cabin totals
        cabinTotals.set(cc, (cabinTotals.get(cc) || 0) + sold);

        // Unique flights
        flightSet.add(flightKey);

        // Alerts (per cabin-flight)
        if (lidded > 0) {
          const lf = (sold / lidded) * 100;
          const flightLabel = `RX ${r.operating_flight_number}${r.operational_suffix || ''}`;
          const routeLabel = `${r.origin} → ${r.destination}`;
          if (lf > 95) alertsHigh.push({ flight: flightLabel, date, route: routeLabel, lf: Math.round(lf * 10) / 10, cabin: CABIN_LETTER[cc] || '?' });
          if (lf < 40) alertsLow.push({ flight: flightLabel, date, route: routeLabel, lf: Math.round(lf * 10) / 10, cabin: CABIN_LETTER[cc] || '?' });
        }
        if (sellable > 0 && sold + held > sellable) {
          const flightLabel = `RX ${r.operating_flight_number}${r.operational_suffix || ''}`;
          const routeLabel = `${r.origin} → ${r.destination}`;
          alertsOverbooking.push({ flight: flightLabel, date, route: routeLabel, cabin: CABIN_LETTER[cc] || '?', soldHeld: sold + held, sellable });
        }
        if (lidded > 0 && sold + held > lidded) {
          const flightLabel = `RX ${r.operating_flight_number}${r.operational_suffix || ''}`;
          const routeLabel = `${r.origin} → ${r.destination}`;
          alertsOverbookingLidded.push({ flight: flightLabel, date, route: routeLabel, cabin: CABIN_LETTER[cc] || '?', soldHeld: sold + held, lidded });
        }
      }

      // Build daily LF array (sorted by date)
      const dailyLoadFactor = [...dailyMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, cabins]) => {
        let totalSold = 0, totalLidded = 0;
        const byCabin = {};
        for (const [cc, { sold, lidded }] of cabins) {
          const letter = CABIN_LETTER[cc] || '?';
          const lf = lidded > 0 ? Math.round((sold / lidded) * 1000) / 10 : null;
          byCabin[letter] = { sold, lidded, lf };
          totalSold += sold;
          totalLidded += lidded;
        }
        return {
          date,
          isToday: date === today,
          overall: { sold: totalSold, lidded: totalLidded, lf: totalLidded > 0 ? Math.round((totalSold / totalLidded) * 1000) / 10 : null },
          cabins: byCabin,
        };
      });

      // Build route rankings
      const routeList = [...routeMap.entries()]
        .filter(([, v]) => v.lidded > 0)
        .map(([key, v]) => ({
          route: `${v.origin} → ${v.destination}`,
          origin: v.origin,
          destination: v.destination,
          lf: Math.round((v.sold / v.lidded) * 1000) / 10,
          flights: v.flights.size,
        }))
        .sort((a, b) => b.lf - a.lf);

      const topRoutes = routeList.slice(0, 5);
      const bottomRoutes = routeList.length > 5
        ? routeList.slice(-5).reverse()
        : routeList.slice().reverse().slice(0, 5);

      // Sort alerts by LF (most extreme first), cap at 5
      alertsHigh.sort((a, b) => b.lf - a.lf);
      alertsLow.sort((a, b) => a.lf - b.lf);
      alertsOverbookingLidded.sort((a, b) => (b.soldHeld - b.lidded) - (a.soldHeld - a.lidded));
      const alerts = {
        highLF: alertsHigh.slice(0, 5),
        lowLF: alertsLow.slice(0, 5),
        overbooking: alertsOverbooking.slice(0, 5),
        overbookingLidded: alertsOverbookingLidded.slice(0, 5),
      };

      const result = {
        period,
        dateRange: { from: dateFrom, to: dateTo },
        dailyLoadFactor,
        topRoutes,
        bottomRoutes,
        alerts,
        totalFlights: flightSet.size,
        totalRows: rows.length,
        cached: false,
        queryMs,
      };

      dashboardCache.set(cacheKey, { data: result, expiresAt: Date.now() + DASHBOARD_CACHE_TTL_MS });
      res.json(result);
    } catch (error) {
      auditError('dashboard_query_failed', error, { env });
      res.status(500).json({ error: 'Dashboard query failed.', details: error.message });
    }
  });

  router.get('/api/environments', (_req, res) => {
    const environments = Object.entries(ENVIRONMENTS).map(([name, cfg]) => ({
      name,
      project: cfg.project,
      isProd: name === 'rx-prd',
    }));
    res.json(environments);
  });
}
