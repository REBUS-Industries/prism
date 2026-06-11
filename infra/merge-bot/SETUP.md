# Merge Bot Setup Guide

The bot adds a `/prism-merge <PR-number>` command to a Slack channel.
It serialises all merges — only one can run at a time — and posts CI status back to the channel.

---

## Part 1 — Create the Slack App (do once, ~5 minutes)

1. Go to **https://api.slack.com/apps** → **Create New App** → **From scratch**
   - App name: `PRISM Merge Bot`
   - Pick your Slack workspace

2. **Add a Bot User**
   - Left menu: **App Home** → scroll to "Your App's Presence in Slack" → Enable a bot user.

3. **Add OAuth scopes**
   - Left menu: **OAuth & Permissions** → scroll to **Bot Token Scopes** → Add:
     - `chat:write` (post messages to the channel)
     - `commands` (handle slash commands)

4. **Install the app to your workspace**
   - Left menu: **OAuth & Permissions** → **Install to Workspace** → Allow
   - Copy the **Bot User OAuth Token** (`xoxb-…`) — you'll need it in Part 2.

5. **Create the slash command**
   - Left menu: **Slash Commands** → **Create New Command**
     - Command: `/prism-merge`
     - Request URL: `https://merge-bot.prism-dev.rebus.industries/merge`
     - Short Description: `Merge a PRISM PR and deploy to dev`
     - Usage Hint: `<PR-number>`
   - Save.

6. **Note the Signing Secret**
   - Left menu: **Basic Information** → **App Credentials** → copy **Signing Secret**

7. **Invite the bot to your Slack channel**
   - In Slack: open the channel → `/invite @PRISM Merge Bot`
   - Copy the Channel ID: right-click the channel → **View channel details** → scroll to bottom → copy the ID (starts with `C`).

---

## Part 2 — Create a GitHub PAT

1. Go to https://github.com/settings/tokens/new (classic token)
2. Note: `prism-merge-bot`
3. Scopes: `repo` (full) + `workflow`
4. Generate → copy the token (`ghp_…`)

---

## Part 3 — Deploy on VM 212

SSH to VM 212:

```bash
ssh rebus@10.0.200.212
cd /opt/prism/infra
```

Create the secrets file (never commit this):

```bash
cp .env.merge-bot.example .env.merge-bot
nano .env.merge-bot   # fill in all four values
```

Build and start the bot:

```bash
docker compose -f docker-compose.dev.yml up -d --build prism-merge-bot
docker compose -f docker-compose.dev.yml logs -f prism-merge-bot
# Should print: Merge bot listening on :3456
```

---

## Part 4 — Expose via Caddy (do once on each proxy)

The Caddy snippet at `infra/Caddyfile.snippet` already includes the `merge-bot.prism-dev.rebus.industries` block.

On LXC 251 and LXC 252 (Caddy proxies):

```bash
# Add the new vhost block to Caddyfile
# (if Caddy already has the prism-dev block, just add the merge-bot block above it)
sudo nano /etc/caddy/Caddyfile
# → paste the merge-bot.prism-dev.rebus.industries block from Caddyfile.snippet

sudo systemctl reload caddy
```

Verify:

```bash
curl https://merge-bot.prism-dev.rebus.industries/health
# → {"ok":true,"locked":false,"lock":null}
```

---

## Part 5 — Test

In your Slack channel:

```
/prism-merge 99
```

Expected flow:
1. Bot replies in-channel: "@you is merging PR #99…"
2. GitHub merges the PR
3. CI builds and deploys (~3-5 min)
4. Bot posts: "✅ PR #99 is live on prism-dev."

If a second `/prism-merge` comes in while one is in-flight:
- Bot replies ephemerally (only visible to you): "🔒 Merge in progress: PR #99 by @alice (2m ago). Wait for it to complete."

---

## Ongoing: how agents use it

Agents never run `gh pr merge` directly. Instead:
1. Agent finishes a feature → opens a PR: `gh pr create --base main --title "..." --body "..."`
2. Agent (or human) checks PR is passing CI on its branch
3. In the Slack channel: `/prism-merge <PR-number>`
4. Bot handles the merge, deploy, and unlock

That's it — the bot is the only thing that merges to main.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/prism-merge` says "dispatch_failed" | Check `GITHUB_TOKEN` has `repo` + `workflow` scopes |
| Bot not responding | `docker compose logs prism-merge-bot` on VM 212 |
| "Invalid Slack signature" in logs | `SLACK_SIGNING_SECRET` is wrong — re-copy from api.slack.com |
| Lock stuck (bot crashed mid-merge) | `curl -X POST https://merge-bot.prism-dev.rebus.industries/unlock-admin` (add this route if needed) or restart the container: `docker compose restart prism-merge-bot` |
| CI deploy times out | Deploy ran fine but took > 12min — check CT 261 disk, re-trigger manually |
