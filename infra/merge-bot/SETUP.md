# Merge Bot Setup Guide

The bot adds a `/prism-merge <PR-number>` command to a Slack channel.
Before each merge it auto-updates the PR branch onto the latest `main` and waits
for required checks to pass, so a merge can never land stale code or drop
concurrent work, and aborts cleanly on conflict (see
"Auto-update / rebase before merge" below).
It serialises all merges â€” only one can run at a time â€” and posts CI status back to the channel.

---

## Part 1 â€” Create the Slack App (do once, ~5 minutes)

1. Go to **https://api.slack.com/apps** â†’ **Create New App** â†’ **From scratch**
   - App name: `PRISM Merge Bot`
   - Pick your Slack workspace

2. **Add a Bot User**
   - Left menu: **App Home** â†’ scroll to "Your App's Presence in Slack" â†’ Enable a bot user.

3. **Add OAuth scopes**
   - Left menu: **OAuth & Permissions** â†’ scroll to **Bot Token Scopes** â†’ Add:
     - `chat:write` (post messages to the channel)
     - `commands` (handle slash commands)

4. **Install the app to your workspace**
   - Left menu: **OAuth & Permissions** â†’ **Install to Workspace** â†’ Allow
   - Copy the **Bot User OAuth Token** (`xoxb-â€¦`) â€” you'll need it in Part 2.

5. **Create the slash command**
   - Left menu: **Slash Commands** â†’ **Create New Command**
     - Command: `/prism-merge`
     - Request URL: `https://merge-bot.prism-dev.rebus.industries/merge`
     - Short Description: `Merge a PRISM PR and deploy to VM 212`
     - Usage Hint: `<PR-number>`
   - Save.

6. **Note the Signing Secret**
   - Left menu: **Basic Information** â†’ **App Credentials** â†’ copy **Signing Secret**

7. **Invite the bot to your Slack channel**
   - In Slack: open the channel â†’ `/invite @PRISM Merge Bot`
   - Copy the Channel ID: right-click the channel â†’ **View channel details** â†’ scroll to bottom â†’ copy the ID (starts with `C`).

---

## Part 2 â€” Create a GitHub PAT

1. Go to https://github.com/settings/tokens/new (classic token)
2. Note: `prism-merge-bot`
3. Scopes: `repo` (full) + `workflow` (`repo` write access also lets the bot update/rebase PR branches onto `main` before merging — no extra scope needed)
4. Generate â†’ copy the token (`ghp_â€¦`)

---

## Part 3 â€” Deploy on CT 271 (RB-DA2-SlackBot)

The bot runs on **CT 271** (`10.0.200.71`) â€” independent of the PRISM stack on VM 212.

On SRV03 (or SSH to `root@10.0.200.71`):

```bash
mkdir -p /opt/merge-bot && cd /opt/merge-bot
# Copy infra/merge-bot/{index.js,package.json,Dockerfile,docker-compose.standalone.yml}
# Rename docker-compose.standalone.yml â†’ docker-compose.yml
# Create .env with SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, GITHUB_TOKEN
# (optional) tune auto-update: AUTO_UPDATE_BRANCH, MERGE_METHOD, UPDATE_CHECKS_TIMEOUT_MINUTES, UPDATE_CHECKS_POLL_SECONDS, UPDATE_MAX_CYCLES
docker compose up -d --build
docker logs prism-merge-bot --tail 5
# Should print: Merge bot listening on :3456
```

See `docker-compose.standalone.yml` and `install-caddy-vhost.sh` in this directory.

---

## Part 4 â€” Expose via Caddy (do once on each proxy)

The Caddy snippet at `infra/Caddyfile.snippet` already includes the `merge-bot.prism-dev.rebus.industries` block.

On LXC 251 and LXC 252 (Caddy proxies):

```bash
# Add the new vhost block to Caddyfile
# (if Caddy already has the prism-dev block, just add the merge-bot block above it)
sudo nano /etc/caddy/Caddyfile
# â†’ paste the merge-bot.prism-dev.rebus.industries block from Caddyfile.snippet

sudo systemctl reload caddy
```

Verify:

```bash
curl https://merge-bot.prism-dev.rebus.industries/health
# â†’ {"ok":true,"locked":false,"lock":null}
```

---

## Part 5 â€” Test

In your Slack channel:

```
/prism-merge 99
```

Expected flow:
1. Bot replies in-channel: "@you is merging PR #99â€¦"
2. GitHub merges the PR
3. CI builds and deploys (~3-5 min)
4. Bot posts: "âœ… PR #99 is live on prism."

If a second `/prism-merge` comes in while one is in-flight:
- Bot replies ephemerally (only visible to you): "ðŸ”’ Merge in progress: PR #99 by @alice (2m ago). Wait for it to complete."

---

## Auto-update / rebase before merge

Before it merges, the bot brings the PR branch up to date with its base (`main`)
and waits for required checks to pass. This guarantees the merged result always
includes the latest `main` and can never overwrite or drop concurrent work that
landed while the PR was waiting between approval and merge.

**How it works (per merge request):**

1. Compare the PR head against `main`. If the head is behind, call GitHub's
   **Update branch** API (`PUT /repos/{owner}/{repo}/pulls/{n}/update-branch`),
   which merges the latest `main` *into* the PR branch (no force-push, no history
   rewrite).
2. Wait for the new head commit to appear, then poll until required checks pass
   (`mergeable_state` becomes `clean`).
3. Merge. If `main` advanced again while waiting, repeat (bounded by
   `UPDATE_MAX_CYCLES` so a busy `main` can't loop forever).

**It ABORTS and merges nothing if:**

- the branch can't be updated cleanly (merge conflict with `main`),
- required checks fail after the update, or
- checks don't finish within `UPDATE_CHECKS_TIMEOUT_MINUTES`.

On any abort it posts a clear Slack message (e.g. "Did not merge #N: it
conflicts with `main` and needs a manual rebase") so a human resolves it. The
bot never force-pushes and never merges a conflicted or stale branch.

**Why "Update branch" (merge) instead of a true rebase:** update-branch merges
`main` into the branch *without* rewriting history, so no commits are ever lost
and CI re-runs against the exact tree that will land. A force-pushed rebase would
rewrite the contributor's branch, and GitHub's "Rebase and merge" replays commits
at merge time onto a base CI never tested together (re-introducing the stale-code
risk). The merged result still contains every commit from `main`, which is the
property we care about. The final merge method is configurable via `MERGE_METHOD`.

**Config (optional env vars):**

| Env var | Default | Purpose |
|---|---|---|
| `AUTO_UPDATE_BRANCH` | `true` | Master switch. Set `false` to restore the old merge-immediately behaviour. |
| `MERGE_METHOD` | `merge` | Final merge method: `merge`, `squash`, or `rebase`. |
| `UPDATE_CHECKS_TIMEOUT_MINUTES` | `15` | Max wait for checks to pass after updating. |
| `UPDATE_CHECKS_POLL_SECONDS` | `15` | Poll interval while waiting for checks. |
| `UPDATE_MAX_CYCLES` | `5` | Max re-updates when `main` keeps moving before aborting. |

All are optional; the bot works with none of them set.

**Token scope:** the existing `GITHUB_TOKEN` (`repo` + `workflow`) already has the
write access required to update branches. A fine-grained PAT instead needs
**Contents: write** and **Pull requests: write** on the target repos.

---

## Ongoing: how agents use it

Agents never run `gh pr merge` directly. Instead:
1. Agent finishes a feature â†’ opens a PR: `gh pr create --base main --title "..." --body "..."`
2. Agent (or human) checks PR is passing CI on its branch
3. In the Slack channel: `/prism-merge <PR-number>`
4. Bot handles the merge, deploy, and unlock

**Check without merging:** `/prism-merge check` (modal) or `/prism-merge check 85` â€” reports mergeability, head CI, and post-merge deploy workflow status (works on merged PRs too).

That's it â€” the bot is the only thing that merges to main.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/prism-merge` says "dispatch_failed" | Check `GITHUB_TOKEN` has `repo` + `workflow` scopes |
| Bot not responding | `docker compose logs prism-merge-bot` on VM 212 |
| "Invalid Slack signature" in logs | `SLACK_SIGNING_SECRET` is wrong â€” re-copy from api.slack.com |
| Lock stuck (bot crashed mid-merge) | `curl -X POST https://merge-bot.prism-dev.rebus.industries/unlock-admin` (add this route if needed) or restart the container: `docker compose restart prism-merge-bot` |
| CI deploy times out | Deploy ran fine but took > 12min â€” check CT 261 disk, re-trigger manually |
