# `agent/src/PRISM.Agent/Pipeline/`

End-to-end job execution. Each `WorkerSlot` instance owns one of these
pipelines.

| File | Purpose |
|---|---|
| `ConvertJob.cs` | Wraps `OrbitConnector.Rhino.Core.RhinoSendPipeline` in headless mode |
| `ReceiveJob.cs` | ORBIT version -> `.3dm` / `.step` bytes via `RhinoDataObject.rawEncoding` |
| `UploadProgress.cs` | Bridges the SDK's progress callbacks to WS `progress` messages |
