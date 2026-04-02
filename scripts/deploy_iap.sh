#!/bin/sh
set -eu

PROJECT_ID="${PROJECT_ID:-prj-lab-alex-zuttre-loadfactor}"
REGION="${REGION:-}"
PROJECT_NUMBER="${PROJECT_NUMBER:-}"
SERVICE="${SERVICE:-loadfactor}"
REPOSITORY="${REPOSITORY:-loadfactor}"
IMAGE_NAME="${IMAGE_NAME:-loadfactor}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-loadfactor-runner@${PROJECT_ID}.iam.gserviceaccount.com}"
SESSION_SECRET_NAME="${SESSION_SECRET_NAME:-loadfactor-session-secret}"
IAP_EXPECTED_AUDIENCE="${IAP_EXPECTED_AUDIENCE:-}"
IAP_ALLOWED_DOMAIN="${IAP_ALLOWED_DOMAIN:-flyr.com}"
BOOTSTRAP_ADMIN_EMAILS="${BOOTSTRAP_ADMIN_EMAILS:-}"
TAG="${TAG:-$(date +%Y%m%d-%H%M%S)}"
IMAGE_URL="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}:${TAG}"

if [ -z "$REGION" ]; then
  echo "Missing required environment variable: REGION" >&2
  exit 1
fi

if [ -z "$PROJECT_NUMBER" ]; then
  echo "Missing required environment variable: PROJECT_NUMBER" >&2
  exit 1
fi

env_vars="AUTH_MODE=iap,GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GOOGLE_CLOUD_PROJECT_NUMBER=${PROJECT_NUMBER},IAP_ALLOWED_DOMAIN=${IAP_ALLOWED_DOMAIN},DEV_AUTH_BYPASS=false"
if [ -n "$IAP_EXPECTED_AUDIENCE" ]; then
  env_vars="${env_vars},IAP_EXPECTED_AUDIENCE=${IAP_EXPECTED_AUDIENCE}"
fi
if [ -n "$BOOTSTRAP_ADMIN_EMAILS" ]; then
  env_vars="${env_vars},BOOTSTRAP_ADMIN_EMAILS=${BOOTSTRAP_ADMIN_EMAILS}"
fi

echo "Building image ${IMAGE_URL}"
gcloud builds submit --project "$PROJECT_ID" --tag "$IMAGE_URL"

echo "Deploying Cloud Run service ${SERVICE} (pass 1)"
gcloud beta run deploy "$SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --image "$IMAGE_URL" \
  --service-account "$SERVICE_ACCOUNT" \
  --no-allow-unauthenticated \
  --iap \
  --set-env-vars "$env_vars" \
  --set-secrets "SESSION_SECRET=${SESSION_SECRET_NAME}:latest"

echo "Granting the IAP service agent Cloud Run invoke access"
gcloud run services add-iam-policy-binding "$SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --member "serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com" \
  --role roles/run.invoker

echo "Deploying Cloud Run service ${SERVICE} (pass 2 to finalize IAP)"
gcloud beta run deploy "$SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --image "$IMAGE_URL" \
  --service-account "$SERVICE_ACCOUNT" \
  --no-allow-unauthenticated \
  --iap \
  --set-env-vars "$env_vars" \
  --set-secrets "SESSION_SECRET=${SESSION_SECRET_NAME}:latest"

echo "Cloud Run IAP deployment finished."
if [ -z "$IAP_EXPECTED_AUDIENCE" ]; then
  echo "Next: sign in once, inspect iap_identity_verified logs to capture the exact aud claim, then redeploy with IAP_EXPECTED_AUDIENCE set."
fi
echo "Next: seed Firestore, grant IAP user access, and request cross-project Spanner access for ${SERVICE_ACCOUNT}."
