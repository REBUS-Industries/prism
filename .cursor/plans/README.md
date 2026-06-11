# Agent onboarding (PRISM)

**Every new Cursor agent session on this repo must read these docs before writing code.**

## Start here

1. **[AGENT-GIT-INSTRUCTIONS.md](./AGENT-GIT-INSTRUCTIONS.md)** — git workflow, PRs, Slack merge bot, `web-image` vs `server-image` deploy
2. **[HANDOFF-overview.md](./HANDOFF-overview.md)** — multi-agent map, conflict zones, deploy checklist
3. **Your workstream handoff** (see table below)

## Workstream handoffs

| Seat | Branch | Handoff |
|---|---|---|
| Materials editor | `feat/materials-editor` | [HANDOFF-materials-editor.md](./HANDOFF-materials-editor.md) |
| Fixture builder | `feat/fixture-builder` | [HANDOFF-fixture-builder.md](./HANDOFF-fixture-builder.md) |
| Connectors | feature branches in **orbit-connectors** | [HANDOFF-connectors.md](./HANDOFF-connectors.md) (pointer) |

## Session-start prompts

**Materials editor:**
```
Read PRISM/.cursor/plans/README.md, AGENT-GIT-INSTRUCTIONS.md, and HANDOFF-materials-editor.md fully before starting any work.
Work only on feat/materials-editor. Do not edit fixture viewer/assembly files.
If the PR touches server/**, run server-image (not just web-image) to deploy API changes to dev.
```

**Fixture builder:**
```
Read PRISM/.cursor/plans/README.md, AGENT-GIT-INSTRUCTIONS.md, and HANDOFF-fixture-builder.md fully before starting any work.
Work only on feat/fixture-builder. Do not edit materials editor files.
If you change web/** only, deploy with web-image. If you change server/**, also run server-image.
```

**Connectors** (open `orbit-connectors` as workspace root — not this repo):
```
Read orbit-connectors/.cursor/plans/README.md and AGENT-GIT-INSTRUCTIONS.md fully before starting any work.
Then read HANDOFF-connectors.md and README.md. Work on feature branches only.
```

## Infra ops (not general feature agents)

Merge-bot setup and CT 271 secrets: `infra/merge-bot/SETUP.md` (committed, no tokens). Do not commit local ops notes that contain secrets.
