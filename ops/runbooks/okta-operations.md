# LoadFactor Okta Operations Runbook

Last updated: 2026-04-01

## Environment
```bash
export PROJECT_ID=<new-loadfactor-project-id>
export REGION=<cloud-run-region>
export SERVICE=loadfactor
export SERVICE_URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"
```

## Snapshot Before Any Change
```bash
gcloud run services describe "$SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --format='value(status.latestReadyRevisionName,status.url)'

gcloud run services describe "$SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --format=json > /tmp/loadfactor_service_snapshot.json
```

## Auth Preflight
```bash
export APP_BASE_URL="$SERVICE_URL"
export EXPECTED_CALLBACK_URL="$SERVICE_URL/auth/callback"
./scripts/oauth_preflight.sh
```

## Local Okta Testing
You can test Okta locally before deploying, as long as the Okta application allows a localhost callback.

Required local setup:
```bash
cp .env.example .env.local
```

Set these values for real local Okta testing:
```bash
DEV_AUTH_BYPASS=false
APP_BASE_URL=http://127.0.0.1:3001
OKTA_ISSUER=<your-okta-issuer>
OKTA_CLIENT_ID=<your-okta-client-id>
OKTA_CLIENT_SECRET=<your-okta-client-secret>
SESSION_SECRET=<local-dev-secret>
```

Your Okta app must include this redirect URI:
```text
http://127.0.0.1:3001/auth/callback
```

Suggested local flow:
1. Start the API with `npm run dev:server`.
2. Open `http://127.0.0.1:3001`.
3. Sign in through Okta.
4. Confirm you get the non-authorized screen first, since `alex.zuttre@flyr.com` is intentionally not in the initial allowlist file.

To seed the initial viewer list:
```bash
node scripts/seed_allowlist.js --file ops/allowlist.initial.json initial-load
```

After you confirm the failure case for your own account, add yourself explicitly:
```bash
node scripts/seed_allowlist.js alex.zuttre@flyr.com admin active initial-load
```

## Acceptance Checklist
1. `GET /healthz` returns `200`.
2. Browser hit to the hosted URL redirects unauthenticated users to Okta.
3. Okta callback returns to the app without a raw server error.
4. `GET /api/me` returns `200` for an allowlisted user and `403` for an authenticated but unapproved user.
5. `GET /api/loadfactor` returns `401` without a session.
6. Allowlisted users can load environments, search load factor, and receive aircraft enrichment.
7. Logout clears the session and future API calls fail until login is repeated.
8. Cloud Run can read the required Spanner projects and the Firestore `user_access` collection.

## Rollback
```bash
OLD_REVISION="$(gcloud run services describe "$SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --format='value(status.latestReadyRevisionName)')"

gcloud run services update-traffic "$SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --to-revisions "${OLD_REVISION}=100"
```

## First-24h Monitoring
- Watch `run.googleapis.com/request_count` by status class.
- Watch `run.googleapis.com/request_latencies` p95.
- Watch application logs for:
  - `auth_login_started`
  - `auth_callback_succeeded`
  - `auth_callback_failed`
  - `allowlist_denied`
  - `request_failed`

## Log Triage Examples
```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="loadfactor" AND jsonPayload.event="auth_callback_failed"' \
  --project "$PROJECT_ID" --limit 50 --freshness=24h --format=json
```

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="loadfactor" AND jsonPayload.event="allowlist_denied"' \
  --project "$PROJECT_ID" --limit 50 --freshness=24h --format=json
```

## Operational Rules
1. Keep `APP_BASE_URL` authoritative in production and pre-register the exact callback URL in Okta.
2. Treat Firestore as the source of truth for authorization; do not manage access in frontend code.
3. Keep `BOOTSTRAP_ADMIN_EMAILS` small and limited to initial admins only.
4. Never log raw tokens, cookie contents, or full Okta responses.
