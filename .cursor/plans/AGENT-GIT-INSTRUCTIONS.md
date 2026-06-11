# Git Instructions for All Agents

**Start:** [README.md](./README.md) in this folder — then your workstream handoff.

**Environment:** All development targets the dev VM (VM 212 — prism-dev.rebus.industries). There is no local dev server.
**Target repo:** `REBUS-Industries/prism` (connectors agents: use `orbit-connectors` — see [HANDOFF-connectors.md](./HANDOFF-connectors.md))
**Your branch:** see your workstream handoff doc — never commit directly to `main`.

> **Every PRISM agent** (materials-editor, fixture-builder, etc.) must follow this doc for merge and deploy. Dev uses two workflows: **`web-image`** for `web/**` changes, **`server-image`** for `server/**` changes. If your PR touches both, run and wait for both.

---

## Daily start — sync your branch with main

Always do this before starting any new work session:

```powershell
git fetch origin
git rebase origin/main
git push --force-with-lease   # only needed if rebase rewrote commits
```

If there are rebase conflicts: resolve them, then `git rebase --continue`.

---

## Working — commit as you go

Commit small and often. Each commit should be a coherent unit (one fix, one feature component).

```powershell
# Stage your changes
git add web/src/admin/components/MyFile.vue
# or stage everything in the changed area
git add web/src/admin/

# Commit with a clear message
git commit -m "feat(web): <what you did>"
# or for fixes:
git commit -m "fix(web): <what you fixed>"

# Push to your branch
git push
```

Commit message format: `feat|fix|chore(scope): description`
Scopes: `web`, `server`, `agent`, `assimp`, `infra`

---

## Build check — run this before opening a PR

```powershell
cd web
npm run build
```

This runs TypeScript type-check + Vite build. It **must pass** before you open a PR — GitHub will block the merge if it fails on CI.

---

## Opening a PR — when a feature is ready

```powershell
# 1. Make sure you're up to date
git fetch origin
git rebase origin/main

# 2. Build must pass
npm run build

# 3. Push your branch
git push

# 4. Open the PR — GitHub prints the PR number at the end
gh pr create --base main --title "feat(web): <feature name>" --body "Brief description of what changed and how to verify on prism-dev."
```

Example output:
```
https://github.com/REBUS-Industries/prism/pull/42
```

**Note that number (42).** You will use it in the next step.

GitHub will run the `build-and-push` CI check automatically. Wait for it to go green before merging.

Check CI status:
```powershell
gh pr checks <PR-number>
```

---

## Merging — use the Slack bot

**Do not** run `gh pr merge` yourself. The Slack bot handles merging so only one merge runs at a time.

In the **#prism-dev** Slack channel, type:

```
/prism-merge 42
```

(replace `42` with your actual PR number)

The bot will:
1. Merge your PR into main
2. Wait for **both** `web-image` and `server-image` deploys when they run (server changes trigger `server-image` automatically)
3. Post back in the channel when everything is live — or if something failed

After merge, GitHub runs:
- **`web-image`** — when `web/**` changed → deploys `prism-web`
- **`server-image`** — when `server/**`, `shared/**`, etc. changed → builds + deploys `prism-server`

Check deploy status:
```powershell
gh run list --repo REBUS-Industries/prism --workflow=server-image --limit 3
gh run list --repo REBUS-Industries/prism --workflow=web-image --limit 3
```

If someone else is already merging, the bot will tell you to wait.

To find your PR number at any time:
```powershell
gh pr list --repo REBUS-Industries/prism
```

---

## Deploying your branch to dev (without merging)

To test your branch on prism-dev before the PR is merged:

```powershell
# Web-only changes
gh workflow run web-image --repo REBUS-Industries/prism --ref <your-branch-name>

# Server API changes (or run both if the PR touches web + server)
gh workflow run server-image --repo REBUS-Industries/prism --ref <your-branch-name>
```

Check progress:
```powershell
gh run list --repo REBUS-Industries/prism --workflow=web-image --limit 3
gh run list --repo REBUS-Industries/prism --workflow=server-image --limit 3
```

If `deploy-dev` is cancelled (flaky runner), wait 2 minutes and re-trigger. Hard-refresh prism-dev after deploy completes.

---

## Quick reference

| Task | Command |
|---|---|
| Sync with main | `git fetch origin; git rebase origin/main` |
| Commit | `git add <files>; git commit -m "feat(web): ..."` |
| Push | `git push` |
| Build check | `cd web; npm run build` |
| Open PR | `gh pr create --base main --title "..." --body "..."` |
| Check CI (web) | `gh run list --repo REBUS-Industries/prism --workflow=web-image --limit 3` |
| Check CI (server) | `gh run list --repo REBUS-Industries/prism --workflow=server-image --limit 3` |
| Deploy branch to dev (web) | `gh workflow run web-image --repo REBUS-Industries/prism --ref <branch>` |
| Deploy branch to dev (server) | `gh workflow run server-image --repo REBUS-Industries/prism --ref <branch>` |
| Merge PR | `gh pr merge <number> --merge` |
| Sync after colleague merges | `git fetch origin; git rebase origin/main` |

---

## Rules

- Never `git push origin main` — branch protection will reject it.
- Never `git push --force` on your branch if others may be using it.
- Never merge two PRs simultaneously — stagger by at least 5 minutes.
- Always run `npm run build` locally before opening a PR.
- If `api.ts` is changed: announce it in team chat so other agents can rebase promptly.
- If the PR touches `server/**`: deploy/test with **`server-image`**, not only `web-image`. On merge, confirm `server-image` deploy-dev completed before assuming API changes are live on dev.
