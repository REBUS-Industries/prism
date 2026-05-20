# `server/src/ws/`

Two WebSocket gateways: one for the agent pool (`/ws/agent`) and one for
admin SPA live updates (`/ws/admin`). Message shapes are defined in JSON
Schema under [`../../../shared/contracts/`](../../../shared/contracts/)
and code-generated into TypeScript types in
[`../../../shared/generated/ts/`](../../../shared/generated/ts/).

| File | Purpose |
|---|---|
| `gateway.ts` | Fastify plugin that registers both `/ws/agent` and `/ws/admin` endpoints |
| `agentProtocol.ts` | Typed handlers for agent messages (hello / heartbeat / progress / log / complete / fail) |
| `adminProtocol.ts` | Typed handlers for admin SPA messages (subscribe to job / workstation / log streams) |
| `sessionRegistry.ts` | Tracks live agent + admin connections, fan-out for broadcast events |
