# Deploy PRISM Server

PRISM Server runs on **VM 211** (`10.0.200.211`) behind Caddy at
`prism.rebus.industries`. The image is built by CI and pushed to
`ghcr.io/rebus-orbit/prism-server:latest`. Deploys are triggered by the
[`deploy.yml`](.github/workflows/deploy.yml) workflow which SSHes to the VM
and runs `docker compose pull && docker compose up -d`.

This is a placeholder runbook — Phase 8 will fill in the concrete steps once
the CI workflows exist. The bones of it:

## First deploy (manual, until Phase 8 is done)

1. SSH to VM 211 as `rebus`:
   ```bash
   ssh -i id_ed25519_rebus rebus@10.0.200.211
   ```
2. Clone the repo to `~/prism`:
   ```bash
   git clone --recurse-submodules \
     https://<TOKEN>@github.com/REBUS-ORBIT/prism.git ~/prism
   cd ~/prism
   ```
3. Copy the env template and fill in real values:
   ```bash
   cp infra/.env.example infra/.env
   $EDITOR infra/.env   # set POSTGRES_PASSWORD, ORBIT_SERVER_URL, etc.
   ```
4. Bring the stack up:
   ```bash
   cd infra
   docker compose up -d
   docker compose ps
   curl -fsS http://localhost:8765/health
   ```

## Caddy

Add the snippet from [`infra/Caddyfile.snippet`](infra/Caddyfile.snippet) to
both proxy LXCs (251 + 252) and `systemctl reload caddy` on each.

## Updates

Once `deploy.yml` exists, pushing to `main` will:

1. Build the server image and push to GHCR.
2. SSH to VM 211 and `docker compose pull && docker compose up -d`.

Until then, on the VM:

```bash
cd ~/prism
git pull --recurse-submodules
cd infra
docker compose pull
docker compose up -d
```

## Rollback

```bash
cd ~/prism/infra
docker compose down
git -C .. checkout <previous-sha>
git -C .. submodule update --init --recursive
docker compose up -d --build
```
