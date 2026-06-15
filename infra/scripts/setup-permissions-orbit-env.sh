#!/usr/bin/env bash
# One-time: copy ORBIT admin tokens from prism settings DB into .env for prism-permissions.
set -euo pipefail
cd /opt/prism

PROD=$(docker compose exec -T postgres psql -U prism -d prism -tAc "select value from settings where key='orbit_token' limit 1" | tr -d '\r\n')
DEV=$(docker compose exec -T postgres psql -U prism -d prism -tAc "select value from settings where key='orbit_dev_token' limit 1" | tr -d '\r\n')

if [[ -z "$PROD" && -z "$DEV" ]]; then
  echo "ERROR: no orbit_token / orbit_dev_token in settings table — configure in PRISM admin Settings first." >&2
  exit 1
fi

touch .env
if [[ -n "$PROD" ]]; then
  if grep -q '^ORBIT_ADMIN_TOKEN=' .env; then
    sed -i "s|^ORBIT_ADMIN_TOKEN=.*|ORBIT_ADMIN_TOKEN=${PROD}|" .env
  else
    echo "ORBIT_ADMIN_TOKEN=${PROD}" >> .env
  fi
fi
if [[ -n "$DEV" ]]; then
  if grep -q '^ORBIT_DEV_ADMIN_TOKEN=' .env; then
    sed -i "s|^ORBIT_DEV_ADMIN_TOKEN=.*|ORBIT_DEV_ADMIN_TOKEN=${DEV}|" .env
  else
    echo "ORBIT_DEV_ADMIN_TOKEN=${DEV}" >> .env
  fi
fi
if ! grep -q '^ORBIT_AUTO_INVITE=' .env; then
  echo "ORBIT_AUTO_INVITE=1" >> .env
fi

docker compose -f docker-compose.dev.yml up -d prism-permissions
echo "prism-permissions restarted with ORBIT admin tokens"
