# PRISM server — deployment runbook

Production target: **VM 211** (`10.0.200.211`). Optional dev mirror:
**VM 212** (`10.0.200.212`). Both are Ubuntu 24.04 VMs running Docker.

## One-time VM setup

```bash
ssh rebus@10.0.200.211
sudo mkdir -p /opt/prism
sudo chown $USER:$USER /opt/prism
cd /opt/prism

# Copy the compose file + env template (the deploy workflow does this on every push,
# but for a first install do it manually so you can populate .env).
scp local:/path/to/prism/infra/docker-compose.yml .
scp local:/path/to/prism/infra/.env.example .env

# Edit .env — see "Required secrets" below.
nano .env

# Pull and start.
docker compose pull
docker compose up -d
docker compose ps
curl -sf http://localhost:8765/health
```

## Caddy snippet

On both proxy LXCs (LXC 251 + LXC 252):

```bash
sudo $EDITOR /etc/caddy/Caddyfile
# Paste the contents of infra/Caddyfile.snippet at the end of the file.
sudo systemctl reload caddy
```

DNS: `prism.rebus.industries` -> the proxy VIP `10.0.200.250` (already
the same A record as the other services).

Add the DC1 internal A record so on-LAN clients resolve straight through
Caddy without leaving the network:

```powershell
# On RB-DA2-DC1
Add-DnsServerResourceRecordA -ZoneName "rebus.industries" `
    -Name "prism" -IPv4Address "185.48.165.165" -CreatePtr
```

## Required secrets

The `infra/.env.example` file documents every variable. The non-defaults
that you MUST set:

| Var                    | Purpose                                                          |
|------------------------|------------------------------------------------------------------|
| `POSTGRES_PASSWORD`    | Postgres user password (used by container + connection string)   |
| `ORBIT_SERVER_URL`     | e.g. `https://orbit.rebus.industries`                            |
| `ORBIT_DEV_SERVER_URL` | optional, dev target                                             |
| `ADMIN_PASSWORD`       | First-boot admin user password                                   |
| `SESSION_SECRET`       | 32+ chars random; signs cookies + internal-download tokens       |
| `PRISM_IMAGE_TAG`      | Pin to a specific image tag in prod (default: `latest`)          |

After editing `.env`, run `docker compose up -d` to apply.

## Deploy

The `.github/workflows/deploy.yml` workflow SSHes to VM 211 on every
green `server-image` build and runs:

```bash
cd /opt/prism
docker compose pull
docker compose up -d
docker compose ps
curl -sf http://localhost:8765/health
```

For manual deploys (e.g. a specific dev tag):

```bash
# On the VM
cd /opt/prism
PRISM_IMAGE_TAG=sha-abc1234 docker compose up -d
```

## DB migrations

Migrations run automatically on boot via `server/src/bootstrap.ts`,
which calls Drizzle's `migrate()` against
`/prism/dist/db/migrations/` (copied in by the Dockerfile). The
admin user is seeded from `ADMIN_USERNAME` + `ADMIN_PASSWORD` if
the `admin_users` table is empty.

## Backups

The two volumes that need backing up are:

```text
prism-postgres-data  /var/lib/postgresql/data    # job history, keys, settings
prism-uploads        /var/lib/prism/uploads      # staged uploads (24h-ish lifetime)
```

Use the existing REBUS volume-backup workflow (Proxmox-side or external).
Uploads are reproducible (clients can re-submit) so postgres is the
priority.

## Rolling back

```bash
cd /opt/prism
# pin to a known-good tag from ghcr.io/rebus-orbit/prism-server
PRISM_IMAGE_TAG=sha-<oldsha> docker compose up -d
docker compose logs -f prism-server
```

Database schema changes between releases must be re-applied manually
if rolling back across them — Drizzle currently only forward-migrates.

## Troubleshooting

- **`/health` returns 200 but admin UI is broken** — check
  `docker logs prism-server` for migration failures; the SPA static
  files won't render until `WEB_DIST_DIR` resolves.
- **Webhook deliveries fail** — outbound HTTPS from VM 211 must be
  unblocked at the gateway. Test with
  `docker exec prism-server wget -qO- https://example.com/`.
- **Agents can't connect** — Caddy's `@ws` matcher must precede the
  generic reverse_proxy directive. Confirm with
  `curl -i https://prism.rebus.industries/ws/agent` (should return 426).
