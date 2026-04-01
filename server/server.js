import express from 'express';
import cors from 'cors';
import { Spanner } from '@google-cloud/spanner';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// ── Environment configuration ─────────────────────────────────────────────
const ENVIRONMENTS = {
  'rx-int':      { project: 'prj-rx-int-ooms-a557', skInstance: 'stockkeeper-euw3-int',      region: 'euw3' },
  'rx-qa':       { project: 'prj-rx-int-ooms-a557', skInstance: 'stockkeeper-euw3-qa',       region: 'euw3' },
  'rx-testing':  { project: 'prj-rx-stg-ooms-a729', skInstance: 'stockkeeper-euw3-testing',  region: 'euw3' },
  'rx-training': { project: 'prj-rx-stg-ooms-a729', skInstance: 'stockkeeper-mec2-training', region: 'mec2' },
  'rx-nft':      { project: 'prj-rx-stg-ooms-a729', skInstance: 'stockkeeper-mec2-nft',      region: 'mec2' },
  'rx-prd':      { project: 'prj-rx-prd-ooms-6f6c', skInstance: 'stockkeeper-mec2-prd',      region: 'mec2' },
};

// ── Spanner client cache (lazy, one per environment) ──────────────────────
const spannerClientCache = new Map();

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

// ── Query timeout helper ──────────────────────────────────────────────────
const QUERY_TIMEOUT_MS = 300_000; // 5 minutes — non-prod instances can be very slow

function withTimeout(promise, ms = QUERY_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`DEADLINE_EXCEEDED: query timed out after ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// ── Load factor query ──────────────────────────────────────────────────────
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

const AIRCRAFT_CACHE_TTL_MS = 10 * 60 * 1000;
const aircraftDetailsCache = new Map();
const SEAT_MAP_CACHE_TTL_MS = 60 * 60 * 1000;
const seatMapNameCache = new Map();
const seatMapCacheRefreshes = new Map();

const SEAT_MAP_NAME_SQL = `
SELECT
  seat_map_id,
  seat_map_version,
  name
FROM seat_maps
WHERE name IS NOT NULL
`;

// ── API endpoint ───────────────────────────────────────────────────────────
app.get('/api/loadfactor', async (req, res) => {
  const { dateFrom, dateTo, origin = '', destination = '', cabins = '', flights = '', env = 'rx-prd' } = req.query;

  if (!ENVIRONMENTS[env]) {
    return res.status(400).json({ error: `Unknown environment: ${env}. Valid: ${Object.keys(ENVIRONMENTS).join(', ')}` });
  }

  if (!dateFrom || !dateTo) {
    return res.status(400).json({ error: 'dateFrom and dateTo are required.' });
  }

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    return res.status(400).json({ error: 'Dates must be in YYYY-MM-DD format.' });
  }

  // Validate IATA codes if provided
  if (origin && !/^[A-Z]{3}$/.test(origin.toUpperCase())) {
    return res.status(400).json({ error: 'Origin must be a 3-letter IATA code.' });
  }
  if (destination && !/^[A-Z]{3}$/.test(destination.toUpperCase())) {
    return res.status(400).json({ error: 'Destination must be a 3-letter IATA code.' });
  }

  // Parse cabin codes: default to all 3 if none specified
  let cabinCodes = [2, 4, 5];
  if (cabins) {
    cabinCodes = cabins.split(',').map(Number).filter(n => [2, 4, 5].includes(n));
    if (cabinCodes.length === 0) cabinCodes = [2, 4, 5];
  }

  let flightFilters = [];
  try {
    flightFilters = parseFlightFilters(flights);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const reqStart = Date.now();
  console.log(`[${env}] Query started — ${dateFrom} to ${dateTo}, cabins: [${cabinCodes}]`);

  let skDatabase;
  try {
    ({ skDatabase } = getSpannerClients(env));
  } catch (err) {
    return res.status(500).json({ error: `Failed to connect to environment ${env}.`, details: err.message });
  }

  try {
    const skQuery = buildLoadFactorStatement({
      dateFrom,
      dateTo,
      origin: origin ? origin.toUpperCase() : '',
      destination: destination ? destination.toUpperCase() : '',
      cabinCodes,
      flightFilters,
    });
    const skQueryStart = Date.now();
    const [rows] = await withTimeout(skDatabase.run(skQuery));
    const skQueryMs = Date.now() - skQueryStart;

    // Convert Spanner rows to plain JSON (aircraft details fetched async via /api/aircraft)
    const results = rows.map((row) => {
      const r = row.toJSON();
      return {
        tracker_id: r.tracker_id ?? null,
        service_instance_id: null,
        departure_date: r.departure_date?.value ?? r.departure_date ?? null,
        origin: r.origin,
        destination: r.destination,
        operating_carrier_code: r.operating_carrier_code,
        operating_flight_number: r.operating_flight_number,
        operational_suffix: r.operational_suffix ?? null,
        aircraft_type: null,
        seat_map_id: null,
        seat_map_name: null,
        cabin_code: intVal(r.cabin_code),
        cabin_name: r.cabin_name,
        physical_capacity: intVal(r.physical_capacity),
        lidded_capacity: intVal(r.lidded_capacity),
        sellable_capacity: intVal(r.sellable_capacity),
        sold: intVal(r.sold),
        held: intVal(r.held),
        available: intVal(r.available),
        sellable_update_source: r.sellable_update_source ?? null,
        sellable_last_updated_at: tsVal(r.sellable_last_updated_at),
        quota_last_updated_at: tsVal(r.quota_last_updated_at),
      };
    });

    console.log(
      `[${env}] Query completed — ${results.length} rows in ${((Date.now() - reqStart) / 1000).toFixed(1)}s `
      + `(SK ${skQueryMs}ms${flightFilters.length ? `, flights filtered in SQL: ${flightFilters.length}` : ''})`
    );

    res.json({
      count: results.length,
      dateFrom,
      dateTo,
      origin: origin ? origin.toUpperCase() : 'ALL',
      destination: destination ? destination.toUpperCase() : 'ALL',
      timings: { skMs: skQueryMs },
      results,
    });
  } catch (err) {
    console.error(`Spanner query error [${env}]:`, err.message || err);
    const isTimeout = err.code === 4 || err.message?.includes('DEADLINE_EXCEEDED') || err.message?.includes('timeout');
    const msg = isTimeout
      ? `Query timed out on ${env}. The environment may be unreachable or your credentials may lack access.`
      : 'Failed to query Spanner.';
    res.status(isTimeout ? 504 : 500).json({ error: msg, details: err.message });
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────
function intVal(v) {
  if (v == null) return null;
  if (typeof v === 'object' && 'value' in v) return Number(v.value);
  return Number(v);
}

function tsVal(v) {
  if (v == null) return null;
  if (typeof v === 'object' && 'value' in v) return v.value;
  if (v instanceof Date) return v.toISOString();
  return String(v);
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

    console.log(`[${env}] Seat map cache refreshed — ${values.size} versions in ${Date.now() - refreshStart}ms`);
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
    refreshSeatMapNameCache(env, pcDatabase).catch((err) => {
      console.error(`Seat map cache refresh error [${env}]:`, err.message || err);
    });
    return cacheEntry.values;
  }

  return refreshSeatMapNameCache(env, pcDatabase);
}

function setCachedAircraftDetails(env, detailsMap) {
  const cache = getAircraftCacheForEnv(env);
  const expiresAt = Date.now() + AIRCRAFT_CACHE_TTL_MS;
  for (const [id, details] of detailsMap) {
    cache.set(id, { value: details, expiresAt });
  }
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
    const r = row.toJSON();
    return [r.tracker_id, r.service_instance_id];
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
    const r = row.toJSON();
    return [r.service_instance_id, {
      aircraft_type: r.aircraft_type ?? null,
      seat_map_id: r.seat_map_id ?? null,
      seat_map_name: r.seat_map_id && r.seat_map_version != null
        ? getSeatMapNameFromCache(env, r.seat_map_id, r.seat_map_version)
        : null,
    }];
  }));
}

// ── Aircraft details endpoint (async enrichment) ──────────────────────────
app.post('/api/aircraft', async (req, res) => {
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
        const skMappingStart = Date.now();
        const trackerToService = await withTimeout(fetchServiceInstancesForTrackers(missingIds, skDatabase));
        const skMappingMs = Date.now() - skMappingStart;

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

        console.log(
          `[${env}] Aircraft enrichment completed — ${detailsMap.size}/${requestedTrackerIds.length} trackers `
          + `(SK map ${skMappingMs}ms, PC ${pcQueryMs}ms, ${missingIds.length} queried, ${requestedTrackerIds.length - missingIds.length} cache hits)`
        );
      } else {
        console.log(`[${env}] Aircraft enrichment served from cache — ${requestedTrackerIds.length} trackers`);
      }

      const result = {};
      for (const [id, details] of detailsMap) {
        result[id] = details;
      }
      return res.json(result);
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
      console.log(
        `[${env}] Aircraft enrichment completed — ${detailsMap.size}/${requestedServiceIds.length} service ids in ${pcQueryMs}ms `
        + `(${missingIds.length} queried, ${requestedServiceIds.length - missingIds.length} cache hits)`
      );
    } else {
      console.log(`[${env}] Aircraft enrichment served from cache — ${requestedServiceIds.length} service ids`);
    }

    const result = {};
    for (const [id, details] of detailsMap) {
      result[id] = details;
    }
    res.json(result);
  } catch (err) {
    console.error(`Aircraft query error [${env}]:`, err.message || err);
    res.status(500).json({ error: 'Failed to fetch aircraft details.', details: err.message });
  }
});

// ── Seat map cache prewarm ────────────────────────────────────────────────
app.post('/api/seatmaps/prewarm', async (req, res) => {
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
  } catch (err) {
    console.error(`Seat map prewarm error [${env}]:`, err.message || err);
    res.status(500).json({ error: 'Failed to prewarm seat maps.', details: err.message });
  }
});

// ── Environments endpoint ──────────────────────────────────────────────────
app.get('/api/environments', (_req, res) => {
  const envs = Object.entries(ENVIRONMENTS).map(([name, cfg]) => ({
    name,
    project: cfg.project,
    isProd: name === 'rx-prd',
  }));
  res.json(envs);
});

// ── Health check ───────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`⚡ LoadFactor API running on http://localhost:${PORT}`);
  console.log(`   Environments: ${Object.keys(ENVIRONMENTS).join(', ')}`);
});
