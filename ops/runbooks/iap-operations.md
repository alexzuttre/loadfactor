# LoadFactor IAP Operations Runbook

Last updated: 2026-04-01

## Current Deployment
- Project: `prj-lab-alex-zuttre-loadfactor`
- Project number: `807872916943`
- Region: `europe-west1`
- Service: `loadfactor`
- Latest ready revision at time of writing: `loadfactor-00002-wnx`
- Current service URL from Cloud Run:
  - `https://loadfactor-x5y6opx5fq-ew.a.run.app`

## Scope
- Temporary Google-auth gate for LoadFactor while Okta approval is pending.
- Direct Cloud Run IAP plus a second app-level Firestore allowlist.
- This rollout secures the URL and the allowlist today.
- Dashboard data queries still need extra cross-project Spanner IAM before the app is fully usable.

## What Was Proven
- Unauthenticated access to the service URL is no longer public.
- Anonymous requests are redirected into Google sign-in by IAP.
- Firestore allowlist was seeded with the initial eight users.
- The same eight users were granted `roles/iap.httpsResourceAccessor` on the Cloud Run IAP resource.
- The service is deployed with `AUTH_MODE=iap` and `DEV_AUTH_BYPASS=false`.

## Known Remaining Gap
- The runtime service account
  - `loadfactor-runner@prj-lab-alex-zuttre-loadfactor.iam.gserviceaccount.com`
  still lacks `roles/spanner.databaseReader` in:
  - `prj-rx-int-ooms-a557`
  - `prj-rx-stg-ooms-a729`
  - `prj-rx-prd-ooms-6f6c`
- Your user did not have `setIamPolicy` permission on those projects, so that part could not be completed from this thread.
- Result:
  - Auth gate works now.
  - `/api/me` and `/api/environments` can work.
  - Spanner-backed data endpoints will fail until those grants are added.

## Required APIs
Enable these in the LoadFactor project:
```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  firestore.googleapis.com \
  iap.googleapis.com \
  iamcredentials.googleapis.com \
  compute.googleapis.com \
  cloudresourcemanager.googleapis.com \
  --project prj-lab-alex-zuttre-loadfactor
```

## One-Time Project Bootstrap
Create Firestore:
```bash
gcloud firestore databases create \
  --project prj-lab-alex-zuttre-loadfactor \
  --location=europe-west1 \
  --type=firestore-native
```

Create Artifact Registry:
```bash
gcloud artifacts repositories create loadfactor \
  --project prj-lab-alex-zuttre-loadfactor \
  --repository-format=docker \
  --location=europe-west1 \
  --description="LoadFactor container images"
```

Create runtime service account:
```bash
gcloud iam service-accounts create loadfactor-runner \
  --project prj-lab-alex-zuttre-loadfactor \
  --display-name="LoadFactor Cloud Run runtime"
```

Grant project-local runtime access:
```bash
gcloud projects add-iam-policy-binding prj-lab-alex-zuttre-loadfactor \
  --member='serviceAccount:loadfactor-runner@prj-lab-alex-zuttre-loadfactor.iam.gserviceaccount.com' \
  --role='roles/datastore.user'

gcloud projects add-iam-policy-binding prj-lab-alex-zuttre-loadfactor \
  --member='serviceAccount:loadfactor-runner@prj-lab-alex-zuttre-loadfactor.iam.gserviceaccount.com' \
  --role='roles/secretmanager.secretAccessor'
```

Create the runtime session secret:
```bash
openssl rand -hex 32 > /tmp/loadfactor-session-secret.txt

gcloud secrets create loadfactor-session-secret \
  --project prj-lab-alex-zuttre-loadfactor \
  --replication-policy=automatic \
  --data-file=/tmp/loadfactor-session-secret.txt
```

## Deploy
Important:
- Install the beta component first:
```bash
gcloud components install beta
```
- Direct Cloud Run IAP required `gcloud beta run deploy` in this environment.
- The first IAP deploy on a brand new project needed two passes:
  - first deploy to trigger IAP service-agent creation
  - grant `roles/run.invoker` to that service agent
  - second deploy to finish IAP enablement

Recommended helper:
```bash
export PROJECT_ID=prj-lab-alex-zuttre-loadfactor
export PROJECT_NUMBER=807872916943
export REGION=europe-west1
export SESSION_SECRET_NAME=loadfactor-session-secret
./scripts/deploy_iap.sh
```

What the helper now does:
1. Builds and pushes the image.
2. Runs `gcloud beta run deploy ... --iap` once.
3. Grants `roles/run.invoker` to:
   - `service-807872916943@gcp-sa-iap.iam.gserviceaccount.com`
4. Runs `gcloud beta run deploy ... --iap` again.

## Allowlist and IAP User Access
Seed Firestore:
```bash
node scripts/seed_allowlist.js --file ops/allowlist.initial.json initial-load
```

Grant the same users IAP access:
```bash
export PROJECT_ID=prj-lab-alex-zuttre-loadfactor
export REGION=europe-west1
export SERVICE=loadfactor
./scripts/grant_iap_access.sh
```

That helper now uses:
```bash
gcloud beta iap web add-iam-policy-binding \
  --project prj-lab-alex-zuttre-loadfactor \
  --member=user:USER_EMAIL \
  --role=roles/iap.httpsResourceAccessor \
  --region=europe-west1 \
  --resource-type=cloud-run \
  --service=loadfactor
```

## Initial Users
- `vamsi.kodam@flyr.com`
- `sebastien.monteil@flyr.com`
- `emmanuel.heitmanntaillefer@flyr.com`
- `bartosz.biernacki@flyr.com`
- `monika.adamus_zajac@flyr.com`
- `magdalena.ksiazek@flyr.com`
- `lukasz.koziel@flyr.com`
- `patryk.stryczek@flyr.com`

## Access Requests
- For temporary LoadFactor access requests, contact `alex.zuttre@flyr.com`.
- If a user is blocked at the Google IAP layer, add them to the Cloud Run IAP policy and the Firestore allowlist.
- If a user is authenticated but blocked by the app, add them to the Firestore `user_access` collection.

## About `IAP_EXPECTED_AUDIENCE`
- Initial deployment was completed with `IAP_EXPECTED_AUDIENCE` unset.
- In that mode, the app still verifies:
  - IAP JWT signature
  - IAP issuer
  - hosted domain
  - signed email consistency
  - Firestore allowlist
- The app logs an `iap_identity_verified` event including the observed `aud` claim.
- After the first successful sign-in, tighten the config by reading that `aud` from logs and redeploying with:
  - `IAP_EXPECTED_AUDIENCE=<exact-aud-from-log>`

Example log query:
```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="loadfactor" AND jsonPayload.event="iap_identity_verified"' \
  --project prj-lab-alex-zuttre-loadfactor \
  --limit 20 \
  --freshness=24h \
  --format=json
```

## Cross-Project Spanner Access Request
Ask a platform admin to grant:
```bash
gcloud projects add-iam-policy-binding prj-rx-int-ooms-a557 \
  --member='serviceAccount:loadfactor-runner@prj-lab-alex-zuttre-loadfactor.iam.gserviceaccount.com' \
  --role='roles/spanner.databaseReader' \
  --condition=None

gcloud projects add-iam-policy-binding prj-rx-stg-ooms-a729 \
  --member='serviceAccount:loadfactor-runner@prj-lab-alex-zuttre-loadfactor.iam.gserviceaccount.com' \
  --role='roles/spanner.databaseReader' \
  --condition=None

gcloud projects add-iam-policy-binding prj-rx-prd-ooms-6f6c \
  --member='serviceAccount:loadfactor-runner@prj-lab-alex-zuttre-loadfactor.iam.gserviceaccount.com' \
  --role='roles/spanner.databaseReader' \
  --condition=None
```

## Verification
Unauthenticated gate:
```bash
curl -si https://loadfactor-807872916943.europe-west1.run.app/
```

Expected result:
- `302`
- redirect to `accounts.google.com`
- no dashboard content returned

IAP policy check:
```bash
gcloud beta iap web get-iam-policy \
  --project prj-lab-alex-zuttre-loadfactor \
  --region=europe-west1 \
  --resource-type=cloud-run \
  --service=loadfactor \
  --format=json
```

Cloud Run state:
```bash
gcloud beta run services describe loadfactor \
  --project prj-lab-alex-zuttre-loadfactor \
  --region europe-west1 \
  --format='yaml(status.url,status.latestReadyRevisionName)'
```

## Operational Rules
1. Keep `DEV_AUTH_BYPASS=false` in Cloud Run.
2. Keep Firestore as the app authorization source of truth.
3. Keep the IAP user list aligned with the Firestore allowlist.
4. After first successful sign-in, tighten `IAP_EXPECTED_AUDIENCE`.
5. Do not expect dashboard data to work until the cross-project Spanner IAM grants are added.
