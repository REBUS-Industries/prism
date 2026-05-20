# `shared/contracts/`

JSON Schema (Draft-07) definitions for every cross-language wire shape.
Single source of truth; both the TypeScript server and the C# agent are
generated from these.

| Schema | Used by |
|---|---|
| [`agent-protocol.json`](agent-protocol.json) | Server's `/ws/agent` handler + the C# agent's `WsClient` |
| [`job-status.json`](job-status.json) | Server's `/api/jobs/:id` response + external `/v1/jobs/:id` |

## Codegen

Phase 2 wires up the generators:

- **TypeScript** -> `shared/generated/ts/*.ts` via [`json-schema-to-typescript`](https://github.com/bcherny/json-schema-to-typescript).
- **C#** -> `shared/generated/cs/*.cs` via [`NJsonSchema.CodeGeneration.CSharp`](https://github.com/RicoSuter/NJsonSchema).

Both outputs are gitignored — they are reproduced from these schemas on
every build (`npm run codegen:contracts` and the `<PreBuild>` target in
`agent/src/PRISM.Agent/PRISM.Agent.csproj`).

## Editing rules

- Bump the `v` constant in `agent-protocol.json` for any breaking change.
- Keep schemas backward-compatible inside a major version (new optional
  fields fine; removing or retyping fields needs `v` bump).
- Update the corresponding code-side handlers in the same PR.
