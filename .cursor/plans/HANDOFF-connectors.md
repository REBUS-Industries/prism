# Handoff: Connectors workstream (pointer)

The connectors workstream lives in a **separate repo**. Do not implement connector changes inside PRISM.

| | |
|---|---|
| **Repo** | `REBUS-Industries/orbit-connectors` |
| **Local path** | `orbit-connectors-repo/` (sibling checkout under ORBIT workspace) |
| **Branch model** | Feature branches off `main` — no conflict risk with PRISM workstreams |

## Agent onboarding (canonical)

Open **`orbit-connectors-repo/`** as the Cursor workspace root, then read:

1. `.cursor/plans/README.md`
2. `.cursor/plans/AGENT-GIT-INSTRUCTIONS.md`
3. `.cursor/plans/HANDOFF-connectors.md`
4. `README.md` (connector architecture spec)

## Why this pointer exists

PRISM multi-agent overview ([HANDOFF-overview.md](./HANDOFF-overview.md)) lists all three seats in one map. The full connectors handoff is maintained in the connectors repo so agents working there do not need PRISM deploy/merge-bot context mixed in.

## Coordination with PRISM

Only needed when a connector change requires a new ORBIT server API, PRISM visualiser behaviour, or a new SDK type. In those cases coordinate with the relevant PRISM or orbit-server dev before merging.
