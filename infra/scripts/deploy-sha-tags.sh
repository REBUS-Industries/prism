#!/usr/bin/env bash
set -eu
TAG="${1:?usage: deploy-sha-tags.sh <sha-tag>}"
cd /opt/prism
if grep -q '^PRISM_WEB_TAG=' .env; then sed -i "s|^PRISM_WEB_TAG=.*|PRISM_WEB_TAG=${TAG}|" .env; else echo "PRISM_WEB_TAG=${TAG}" >> .env; fi
if grep -q '^PRISM_IMAGE_TAG=' .env; then sed -i "s|^PRISM_IMAGE_TAG=.*|PRISM_IMAGE_TAG=${TAG}|" .env; else echo "PRISM_IMAGE_TAG=${TAG}" >> .env; fi
grep -E '^(PRISM_WEB_TAG|PRISM_IMAGE_TAG|PUBLIC_BASE)=' .env
docker compose pull prism-web prism-server prism-materials
docker compose up -d prism-web prism-server prism-materials prism-permissions prism-router
sleep 5
docker compose ps prism-web prism-server prism-materials
