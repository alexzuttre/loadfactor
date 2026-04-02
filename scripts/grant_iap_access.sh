#!/bin/sh
set -eu

PROJECT_ID="${PROJECT_ID:-prj-lab-alex-zuttre-loadfactor}"
REGION="${REGION:-}"
SERVICE="${SERVICE:-loadfactor}"
ALLOWLIST_FILE="${ALLOWLIST_FILE:-ops/allowlist.initial.json}"

if [ -z "$REGION" ]; then
  echo "Missing required environment variable: REGION" >&2
  exit 1
fi

if [ ! -f "$ALLOWLIST_FILE" ]; then
  echo "Allowlist file not found: $ALLOWLIST_FILE" >&2
  exit 1
fi

node --input-type=module -e "
  import fs from 'fs';
  const entries = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  for (const entry of entries) {
    const email = String(entry?.email || '').trim();
    if (email) console.log(email);
  }
" "$ALLOWLIST_FILE" | while IFS= read -r email; do
  echo "Granting IAP access to ${email}"
  gcloud beta iap web add-iam-policy-binding \
    --project "$PROJECT_ID" \
    --member "user:${email}" \
    --role roles/iap.httpsResourceAccessor \
    --region "$REGION" \
    --resource-type cloud-run \
    --service "$SERVICE"
done

echo "Finished granting IAP access from ${ALLOWLIST_FILE}."
