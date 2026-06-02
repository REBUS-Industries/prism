# Visualiser TURN server — Setup Notes

Date created: 2026-05-27 | Last updated: 2026-05-27 (relay range narrowed to `52000-56999` to avoid WireGuard 51820/udp; public DNS A record live)

`coturn` on VM 211 provides WebRTC media relay for the PRISM Visualiser
feature. End users' browsers (anywhere on the public internet) connect
to `visualiser.rebus.industries`; coturn relays the WebRTC media to a
workstation behind PRISM running Unreal Engine 5.7 + Pixel Streaming 2.

This folder is **deployment configuration only** — it is not in a git
repo, it lives alongside the rest of the REBUS infra notes. The PRISM
repo carries matching env defaults (`PRISM/infra/.env.example`) and a
`v0.1.39` CHANGELOG entry pointing at this folder.

---

## Overview

| Property | Value |
|---|---|
| **Host** | VM 211 (`10.0.200.211`), Ubuntu 24.04 |
| **Image** | `coturn/coturn:4.6` |
| **Networking** | host (relay range is too wide for bridge mode) |
| **Public hostname** | `visualiser.rebus.industries` |
| **Public IP** | `185.48.165.165` (UniFi alias on eth2) |
| **Ports — TURN/STUN** | `3478/udp`, `3478/tcp` |
| **Ports — TURN-S (TLS)** | `5349/tcp` |
| **Ports — relay range** | `52000-56999/udp` (narrowed from coturn's `49152-65535` default to avoid WireGuard `51820/udp`) |
| **Auth** | RFC 7635 long-term creds, shared secret with PRISM |
| **Realm** | `visualiser.rebus.industries` |

The **same** `static-auth-secret` value MUST be set in:
1. `turnserver.conf` here on VM 211, and
2. `~rebus/prism/.env` as `TURN_SECRET=` (consumed by `prism-server` via
   `server/src/visualiser/turnCredentials.ts`).

Without that match the portal-facing `POST /api/visualiser/streams`
response carries credentials that coturn will reject.

---

## Deployment runbook

> ⚠ **Operator action required.** This runbook is the deploy artifact;
> agents do not execute these steps unsupervised. Follow them yourself
> (or in a controlled SSH session) once Phase H is reviewed and merged.

### 1. Generate the shared secret

```bash
openssl rand -hex 32
# example: 7c5b1f...c40d   (64 hex chars)
```

Save it somewhere durable (1Password, ops vault, etc.) — it appears in
two places below.

### 2. Stage the config on VM 211

```bash
# From your laptop:
scp -i id_ed25519_rebus \
    "infra/coturn/docker-compose.yml" \
    "infra/coturn/turnserver.conf" \
    rebus@10.0.200.211:~/coturn/
```

(SSH into VM 211 first if `~/coturn` doesn't exist:
`mkdir -p ~/coturn`.)

### 3. Substitute the placeholder

```bash
ssh rebus@10.0.200.211
cd ~/coturn
# Replace <TURN_SECRET_PLACEHOLDER> with the secret from step 1.
sed -i "s/<TURN_SECRET_PLACEHOLDER>/$YOUR_SECRET/" turnserver.conf
# Verify (no placeholder should remain, no 'static-auth-secret=' line
# should be left bare):
grep -E "static-auth-secret|TURN_SECRET_PLACEHOLDER" turnserver.conf
```

### 4. Add the matching secret to PRISM server

```bash
# Same VM (PRISM server lives in /opt/prism per DEPLOY.md):
cd /opt/prism
$EDITOR .env
# Add (or edit) these four lines:
#   TURN_SECRET=$YOUR_SECRET
#   TURN_REALM=visualiser.rebus.industries
#   JWT_SIGNALLING_SECRET=$(openssl rand -hex 32)
#   VISUALISER_START_TIMEOUT_MS=180000
# The JWT_SIGNALLING_SECRET is a separate secret (NOT the TURN one)
# used to sign 5-minute WS signalling tokens. Generate independently.
```

### 5. Start coturn

```bash
cd ~/coturn
docker compose up -d
docker compose logs --tail=40 coturn
```

You should see lines along the lines of:

```
0: log file opened: stdout
0: pid file created: /var/tmp/turnserver.pid
0: IPv4. Listener opened on : 0.0.0.0:3478
0: IPv4. Listener opened on : 0.0.0.0:3478
0: Total: 1 'Quota' values, 0 'Bandwidth' values
0: Server relay listener opened on : 0.0.0.0:52000
```

If the logs show `Cannot open certificate file` for the `5349` listener
that's expected — Step 8 below brings TLS online. Plain TURN on 3478
should be working at this point.

### 6. Restart PRISM server to pick up the new env

```bash
cd /opt/prism
docker compose restart prism-server
docker compose logs --tail=20 prism-server | grep -i turn
```

PRISM doesn't log the secret itself, but it does log a startup line
confirming the realm and that TURN credentials will be minted (rather
than the Phase G `turn: null` sentinel).

### 7. UniFi gateway port forwards

Apply the rules from `UNIFI_RULES.md` in this folder. UniFi Console →
Settings → Internet → Port Forwarding. Until these are applied the
browser sees the credentials but cannot reach the relay — symptom is
WebRTC ICE negotiation fails after ~30s.

### 8. DNS

**Public DNS** — A record at the registrar (✅ **live as of 2026-05-27**):

| Name | Type | Target | Status |
|---|---|---|---|
| `visualiser.rebus.industries` | A | `185.48.165.165` | ✅ live (2026-05-27) |

**Internal AD DNS** — add a static A record on RB-DA2-DC1
(`10.0.10.151`) so workstations on VLAN 10 / 200 reach coturn directly
without hairpinning out to the public IP:

```powershell
# On RB-DA2-DC1, elevated PowerShell:
Add-DnsServerResourceRecordA -ZoneName "rebus.industries" `
    -Name "visualiser" -IPv4Address "10.0.200.211" -CreatePtr
```

### 9. TLS cert (`turns://` on 5349)

Default approach: **certbot `--standalone`** on VM 211. UniFi port 80
must briefly be allowed inbound to `10.0.200.211:80` for HTTP-01.

```bash
# One-off issue (Caddy on the proxy LXCs is NOT serving 185.48.165.165:80
# for this host — port-forward must hit VM 211 directly during renewal).
ssh rebus@10.0.200.211

# Install certbot if not present:
sudo apt update && sudo apt install -y certbot

# Temporarily stop anything bound to :80 on VM 211 (PRISM server is on
# :8765 so this is usually a no-op):
sudo ss -lntp | grep ':80 ' && echo "stop the listener first!"

# Issue:
sudo certbot certonly --standalone \
    -d visualiser.rebus.industries \
    --agree-tos --no-eff-email -m admin@rebus.industries

# Hook up coturn to the cert. Uncomment the cert= / pkey= lines in
# turnserver.conf (paths are already correct):
sudo $EDITOR ~/coturn/turnserver.conf
docker compose -f ~/coturn/docker-compose.yml restart coturn

# Renewal hook so coturn picks up the new cert without manual restarts:
sudo tee /etc/letsencrypt/renewal-hooks/deploy/coturn-restart.sh > /dev/null <<'EOF'
#!/usr/bin/env bash
set -e
docker restart coturn
EOF
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/coturn-restart.sh
```

certbot's package installs a `certbot.timer` systemd unit on Ubuntu
24.04 that runs `certbot renew` twice daily — no extra cron needed.

> **Alternative — Caddy export.** If you'd rather not run certbot
> separately, the proxy pair already manages a cert for the host (via
> the new Caddyfile block) and you can rsync
> `/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/visualiser.rebus.industries/`
> to VM 211 on a timer. The certbot path is preferred for v1 because
> coturn ships on a different host from Caddy and we want a single
> source of truth for the cert.

### 10. Smoke tests

```bash
# Plain STUN binding (run from anywhere on the public internet):
echo -n "" | nc -u -w 2 visualiser.rebus.industries 3478

# Better: the WebRTC sample's "Trickle ICE" page accepts ICE-server
# config and reports each candidate:
#   https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/
# Mint a credential via PRISM:
curl -s -X POST https://prism.rebus.industries/api/visualiser/streams \
     -H "X-API-Key: $YOUR_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"projectId":"...","modelId":"...","versionId":"..."}' \
     | jq .turn
# Paste the urls/username/credential into the Trickle ICE page; expect
# 'relay' candidates from 185.48.165.165 to appear within ~2s.
```

If `relay` candidates never appear:
- check `docker logs coturn` for `441 (Wrong Credentials)` — secret mismatch
- check the UniFi inbound rules — `nc -uvz 185.48.165.165 3478` must succeed
- check the firewall on VM 211 itself (`sudo ufw status`) — coturn host
  networking means UFW rules apply if the firewall is enabled

---

## Operations

### Rotating the secret

```bash
NEW=$(openssl rand -hex 32)
# 1. Update coturn:
ssh rebus@10.0.200.211 "sed -i \"s/^static-auth-secret=.*/static-auth-secret=$NEW/\" ~/coturn/turnserver.conf && cd ~/coturn && docker compose restart"
# 2. Update PRISM:
ssh rebus@10.0.200.211 "sed -i \"s/^TURN_SECRET=.*/TURN_SECRET=$NEW/\" /opt/prism/.env && cd /opt/prism && docker compose restart prism-server"
```

Active streams during the swap will fail their next ICE round; the
portal can re-issue by calling `POST /api/visualiser/streams` again.

### Reading credentials currently in flight

`/var/lib/coturn/turndb` (the volume-mounted database) is only used
for the local-credential mechanism; with `use-auth-secret` it is
effectively empty. Active allocations show up in
`docker exec coturn turnadmin -L -r visualiser.rebus.industries`.

### Bandwidth monitoring

Each 1080p60 H.264 Pixel Streaming session is approximately 5–10 Mbps
relayed bidirectionally. The VM 211 WAN feed (185.48.165.165) has
finite headroom — Phase K is planned to surface
`max_active_visualiser_streams` in the PRISM admin UI. Until then,
treat the deployment as a 1-2 concurrent-stream system.

---

## Known limitations / follow-ups

- TLS is delivered by certbot rather than Caddy. The proxy pair runs
  Caddy and could in principle export certs via DNS-01, but coturn is
  on a different host (VM 211, not the proxy LXCs) so a cert-rsync
  step is required regardless. Certbot-standalone is simplest for v1.
- coturn 4.6 is the current stable line. Plan to bump to 4.7 once it
  ships and a 4.6 → 4.7 changelog review is done.
- Bandwidth quotas are in raw stream count, not Mbps. coturn supports
  `bps-capacity` but matching it to real Pixel Streaming bitrate
  variance is brittle; revisit if real-world contention shows up.
