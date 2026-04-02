#!/bin/sh
set -eu

AUTH_MODE="${AUTH_MODE:-okta}"

base_required_vars="SESSION_SECRET"

for var_name in $base_required_vars; do
  eval "value=\${$var_name:-}"
  if [ -z "$value" ]; then
    echo "Missing required environment variable: $var_name" >&2
    exit 1
  fi
done

case "$AUTH_MODE" in
  okta)
    APP_BASE_URL="${APP_BASE_URL%/}"
    if [ -z "$APP_BASE_URL" ]; then
      echo "Missing required environment variable: APP_BASE_URL" >&2
      exit 1
    fi

    required_vars="OKTA_ISSUER OKTA_CLIENT_ID OKTA_CLIENT_SECRET"
    for var_name in $required_vars; do
      eval "value=\${$var_name:-}"
      if [ -z "$value" ]; then
        echo "Missing required environment variable: $var_name" >&2
        exit 1
      fi
    done

    OKTA_ISSUER="${OKTA_ISSUER%/}"
    EXPECTED_CALLBACK_URL="${EXPECTED_CALLBACK_URL:-$APP_BASE_URL/auth/callback}"
    ACTUAL_CALLBACK_URL="$APP_BASE_URL/auth/callback"

    if [ "$EXPECTED_CALLBACK_URL" != "$ACTUAL_CALLBACK_URL" ]; then
      echo "Callback URL mismatch: expected $EXPECTED_CALLBACK_URL but resolved $ACTUAL_CALLBACK_URL" >&2
      exit 1
    fi

    DISCOVERY_URL="$OKTA_ISSUER/.well-known/openid-configuration"
    if command -v curl >/dev/null 2>&1; then
      curl -fsS "$DISCOVERY_URL" >/dev/null
    fi
    ;;
  iap)
    required_vars="GOOGLE_CLOUD_PROJECT"
    for var_name in $required_vars; do
      eval "value=\${$var_name:-}"
      if [ -z "$value" ]; then
        echo "Missing required environment variable: $var_name" >&2
        exit 1
      fi
    done

    if [ "${DEV_AUTH_BYPASS:-false}" = "true" ]; then
      echo "DEV_AUTH_BYPASS must be false for IAP deployment." >&2
      exit 1
    fi

    if [ -z "${IAP_EXPECTED_AUDIENCE:-}" ]; then
      echo "Warning: IAP_EXPECTED_AUDIENCE is empty. Initial direct-IAP rollout will rely on signature verification only until you capture the aud claim from logs and redeploy." >&2
    fi
    ;;
  *)
    echo "Unsupported AUTH_MODE: $AUTH_MODE" >&2
    exit 1
    ;;
esac

if [ -z "${BOOTSTRAP_ADMIN_EMAILS:-}" ]; then
  echo "Warning: BOOTSTRAP_ADMIN_EMAILS is empty. First-login bootstrap will not seed any admins." >&2
fi

echo "Auth preflight passed for AUTH_MODE=$AUTH_MODE."
