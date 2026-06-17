# `.github/workflows/`

CI pipelines for PRISM.

| Workflow | Trigger | Deploy (VM 212) |
|---|---|---|
| `web-image` (`web.yml`) | push to `main`, paths `web/**`; **PR:** `npm run build` only (no image push) | Builds + deploys `prism-web` (+ `prism-fixtures`, `prism-models`, `prism-router`) |
| `server-image` (`server.yml`) | push to `main`, paths `server/**` `shared/**` `agent/install/**` … | Builds + deploys `prism-server` (+ related services) |
| `agent.yml` | tag matching `agent-v*` | — |
| `assimp.yml` | push to `main`, paths `assimp/**` | — |

**On merge to `main`:** each workflow runs independently when its path filter matches. A PR that touches both `web/**` and `server/**` triggers **both** workflows. The Slack merge bot waits for all triggered deploy workflows to finish before reporting success.

**Manual deploy of a feature branch:**
```powershell
gh workflow run web-image --repo REBUS-Industries/prism --ref <branch>
gh workflow run server-image --repo REBUS-Industries/prism --ref <branch>
```

There is one PRISM environment — VM 212 (`prism.rebus.industries`); merges to `main` deploy there. `v*` tags / `workflow_dispatch` produce pinned release images. VM 211 is ORBIT-only (the tag-gated PRISM monolith there was decommissioned 2026-06-16).
