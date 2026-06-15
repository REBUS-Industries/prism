# Multi-Agent Development — Overview

Three concurrent workstreams, two repos, three developer seats (human + Cursor agent each).

---

## Workstream map

| Workstream | Repo | Branch | Handoff doc | Who |
|---|---|---|---|---|
| **Fixture builder** | `REBUS-Industries/prism` | `feat/fixture-builder` | `HANDOFF-fixture-builder.md` | Colleague PC |
| **Materials editor** | `REBUS-Industries/prism` | `feat/materials-editor` | `HANDOFF-materials-editor.md` | Main dev PC |
| **Model library** | `REBUS-Industries/prism` + `prism-models-service` | `feat/model-library` | `HANDOFF-model-library.md` | Dedicated agent seat |
| **Permissions** | `REBUS-Industries/prism` + `prism-permissions-service` | `feat/permissions` | `HANDOFF-permissions.md` | Permissions agent seat |
| **Connectors** | `REBUS-Industries/orbit-connectors` | feature branches off `main` | `orbit-connectors/.cursor/plans/HANDOFF-connectors.md` | Third seat (or async) |

Fixture builder + materials editor + model library share one repo but use separate branches and own mostly non-overlapping files. Connectors are a completely separate repo with no cross-repo conflict risk.

---

## Conflict zones (the only files where both PRISM workstreams touch)

| File | Risk | Protocol |
|---|---|---|
| `web/src/shared/api.ts` | Both workstreams add types here | Coordinate before merging: add to the end of the relevant interface block; one dev rebases off the other's merged PR before pushing their own |
| `web/src/admin/App.vue` | Routes + nav — rare changes | Announce in team chat before touching; review both PRs before merge |
| `server/src/db/schema.ts` + migration files | DB schema — materials owns, fixtures reads | Materials-editor dev owns; fixtures-editor dev opens an issue if they need a schema change |

Everything else is cleanly separated by file.

---

## Branch strategy

```
main  ←── feat/fixture-builder  (PR when feature complete)
      ←── feat/materials-editor (PR when feature complete)
      ←── feat/model-library    (PR when feature complete)
```

- Keep branches short-lived. Merge a logical feature (not a months-long branch).
- After a PR merges to `main`, the other branch dev **must rebase** before their next PR:
  ```powershell
  git fetch origin
  git rebase origin/main
  ```
- Never push directly to `main`. Always PR.

---

## Deploy workflow

**All agents:** read `AGENT-GIT-INSTRUCTIONS.md` first — it covers git, merge bot, and deploy commands.

Dev (VM 212 — prism-dev.rebus.industries) uses **two separate CI workflows**. Run the one(s) that match what you changed:

| You changed | Workflow | What it deploys |
|---|---|---|
| `web/**` only | `web-image` | `prism-web` (admin SPA) |
| `server/**`, `shared/**`, etc. | `server-image` | `prism-server` (API) |
| Both web + server | **both** | web + server |

### Auto-deploy on merge to `main`

When a PR merges, GitHub runs whichever workflows match the changed paths. The Slack merge bot waits for **all** triggered deploys (`web-image` + `server-image`) before reporting success.

### Manual deploy of a feature branch (before merge)

```powershell
# Web/UI changes only (most fixture-builder PRs)
gh workflow run web-image --repo REBUS-Industries/prism --ref feat/fixture-builder

# Server API / DB / shared contract changes (materials-editor PRs with server/**)
gh workflow run server-image --repo REBUS-Industries/prism --ref feat/materials-editor

# PR touches both — run both, wait for both deploy-dev jobs to finish
gh workflow run web-image --repo REBUS-Industries/prism --ref <branch>
gh workflow run server-image --repo REBUS-Industries/prism --ref <branch>
```

### Check deploy status

```powershell
gh run list --repo REBUS-Industries/prism --workflow=web-image --limit 5
gh run list --repo REBUS-Industries/prism --workflow=server-image --limit 5
gh run view <run-id> --repo REBUS-Industries/prism
```

> CT 261 (self-hosted runner) is flaky — low disk / concurrency issues. If `deploy-dev` is cancelled, wait ~2 min and re-trigger. The image build (`build-and-push`) usually succeeds regardless; only `deploy-dev` is affected.

### Prod (VM 211 — prism.rebus.industries)

**Tag-gated — never auto-deploys from a branch or from main.** Only a `v*` tag triggers prod. Prod deploys are always manual + intentional.

---

## Cursor agent setup on each PC

Each seat runs its own Cursor instance pointing at its own local checkout, on its own branch. No special cross-machine Cursor configuration is needed — it's standard git isolation.

**Recommended Cursor session start prompt for each seat:**

For the fixture-builder seat:
```
Read PRISM/.cursor/plans/AGENT-GIT-INSTRUCTIONS.md and HANDOFF-fixture-builder.md fully before starting any work.
Work only on the feat/fixture-builder branch. Do not edit materials editor files.
If you change web/** only, deploy with web-image. If you change server/**, also run server-image.
```

For the materials-editor seat:
```
Read PRISM/.cursor/plans/AGENT-GIT-INSTRUCTIONS.md and HANDOFF-materials-editor.md fully before starting any work.
Work only on the feat/materials-editor branch. Do not edit fixture viewer/assembly files.
If the PR touches server/**, run server-image (not just web-image) to deploy API changes to dev.
```

For the connectors seat (open **orbit-connectors** as workspace root):
```
Read .cursor/plans/README.md, AGENT-GIT-INSTRUCTIONS.md, and HANDOFF-connectors.md fully before starting any work.
Then read README.md. Work on feature branches off main only.
```

---

## Coordination checklist before each PR merge

- [ ] `npm run build` passes on the branch (`cd PRISM/web && npm run build`)
- [ ] No lint errors on edited files
- [ ] If `api.ts` was touched: confirm no type conflict with the other PRISM branch
- [ ] PR description lists what changed and how to test on prism-dev
- [ ] If PR touches `server/**`: confirm `server-image` deploy ran (not just `web-image`)
- [ ] After merge: other PRISM branch dev rebases (`git rebase origin/main`)

---

## Infrastructure limits

| Limit | Impact |
|---|---|
| CT 261 (deploy runner) — 1 concurrent job | Two PRs merging to main within seconds of each other can queue. The second deploy just waits or gets cancelled by the concurrency guard — re-trigger manually. |
| Low disk on CT 261 (~20 MB free) | `deploy-dev` can fail at setup. Manual fix: SSH to SRV03 CT 261, `apt clean`, `docker system prune`. |
| Prod is tag-gated | Cannot accidentally deploy to prod from a feature branch. |

---

## Quick reference

| Task | Command |
|---|---|
| Create feature branch | `git checkout -b feat/<name>; git push -u origin feat/<name>` |
| Deploy branch to dev (web) | `gh workflow run web-image --repo REBUS-Industries/prism --ref <branch>` |
| Deploy branch to dev (server) | `gh workflow run server-image --repo REBUS-Industries/prism --ref <branch>` |
| Check CI (web) | `gh run list --repo REBUS-Industries/prism --workflow=web-image --limit 5` |
| Check CI (server) | `gh run list --repo REBUS-Industries/prism --workflow=server-image --limit 5` |
| Open PR | `gh pr create --base main --title "..." --body "..."` |
| Rebase after colleague merges | `git fetch origin; git rebase origin/main` |
