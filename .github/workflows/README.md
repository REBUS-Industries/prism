# `.github/workflows/`

CI pipelines for PRISM.

| Workflow | Trigger | Dev deploy (VM 212) |
|---|---|---|
| `web-image` (`web.yml`) | push to `main` or `feat/permissions`, paths `web/**`; **PR:** `npm run build` only (no image push) | Builds + deploys `prism-web` (+ `prism-fixtures`, `prism-models`, `prism-router`) |
| `server-image` (`server.yml`) | push to `main`, paths `server/**` `shared/**` `agent/install/**` … | Builds + deploys `prism-server` (+ related services) |
| `agent.yml` | tag matching `agent-v*` | — |
| `assimp.yml` | push to `main`, paths `assimp/**` | — |

**On merge to `main`:** each workflow runs independently when its path filter matches. A PR that touches both `web/**` and `server/**` triggers **both** workflows. The Slack merge bot waits for all triggered deploy workflows to finish before reporting success.

**`feat/permissions`:** pushes that touch `web/**` auto-build and deploy to VM 212 (same as `main`).

**Manual deploy of other feature branches:**
```powershell
gh workflow run web-image --repo REBUS-Industries/prism --ref <branch>
gh workflow run server-image --repo REBUS-Industries/prism --ref <branch>
```

Prod (VM 211) is tag-gated — `server-image` prod deploy runs only on `v*` tags or `workflow_dispatch`.
