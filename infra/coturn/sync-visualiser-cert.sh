#!/bin/bash
# sync-visualiser-cert.sh — pull the visualiser.rebus.industries TLS cert
# from Proxy1's Caddy data dir into ~rebus/coturn/certs/, and restart
# coturn iff the cert changed.
#
# DEPLOYED LOCATION: /usr/local/bin/sync-visualiser-cert.sh on VM 211
# (root:root 755). This file in the workspace is the master copy.
#
# Runs daily via cron under the `rebus` user. Caddy ACMEs and renews
# the cert; this script is a one-way mirror that no-ops when the cert
# hasn't changed and `docker compose restart coturn`s when it has.
#
# Permissions: the script SCPs as the `rebus` user, but uses the
# ~rebus/.ssh/proxy_cert_sync key which is authorised as `root` on the
# Proxy1 LXC so it can read /var/lib/caddy/.local/share/caddy/...
# (owned by caddy:caddy 600).
set -euo pipefail

PROXY=10.0.200.251
PROXY_USER=root
KEY=$HOME/.ssh/proxy_cert_sync
SRC_BASE=/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/visualiser.rebus.industries
DEST=$HOME/coturn/certs
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

scp -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
    "${PROXY_USER}@${PROXY}:${SRC_BASE}/visualiser.rebus.industries.crt" \
    "$TMP/fullchain.pem"

scp -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
    "${PROXY_USER}@${PROXY}:${SRC_BASE}/visualiser.rebus.industries.key" \
    "$TMP/privkey.pem"

mkdir -p "$DEST"

CHANGED=0
if ! cmp -s "$TMP/fullchain.pem" "$DEST/fullchain.pem" 2>/dev/null; then
    cp "$TMP/fullchain.pem" "$DEST/fullchain.pem"
    chmod 644 "$DEST/fullchain.pem"
    CHANGED=1
fi
if ! cmp -s "$TMP/privkey.pem" "$DEST/privkey.pem" 2>/dev/null; then
    cp "$TMP/privkey.pem" "$DEST/privkey.pem"
    # NOTE: 644 (world-readable) is intentional. The coturn 4.6 container
    # runs as `nobody` (UID 65534) and host-bind mounts preserve uid/gid,
    # so 640 rebus:rebus would be unreadable inside the container. The
    # file lives on a single-tenant VM with no other unprivileged users
    # in /home/rebus, so world-readable here is operationally equivalent
    # to the certbot default of root-owned 600 in /etc/letsencrypt.
    chmod 644 "$DEST/privkey.pem"
    CHANGED=1
fi

if [ "$CHANGED" -eq 1 ]; then
    echo "$(date -Is) cert changed — restarting coturn"
    cd "$HOME/coturn" && docker compose restart coturn
else
    echo "$(date -Is) cert unchanged — no action"
fi
