# `agent/src/PRISM.Agent/Ws/`

WebSocket client + message dispatch. Uses
[Websocket.Client](https://github.com/Marfusios/websocket-client) for
auto-reconnect and back-off.

| File | Purpose |
|---|---|
| `WsClient.cs` | Connects to `prismUrl`, handles reconnect, exposes typed send / receive |
| `AgentMessageDispatcher.cs` | Routes incoming `Assign` / `Cancel` / `PollLayers` to slot pool |
| `Outbox.cs` | Buffers outbound `Progress` / `Log` messages while disconnected, flushes on reconnect |

Types in this folder come from
[`../../../../shared/contracts/agent-protocol.json`](../../../../shared/contracts/agent-protocol.json)
via NJsonSchema codegen (Phase 2 wires the MSBuild pre-build target).
