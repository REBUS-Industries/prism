# `agent/src/PRISM.Agent/Rhino/`

Rhino.Inside host and per-format file openers. One Rhino subprocess per
worker slot — Rhino.Inside hosts Rhino inside the agent process for
in-proc API access.

| File | Purpose |
|---|---|
| `RhinoHost.cs` | Boots Rhino.Inside, exposes a per-slot `RhinoDoc` factory |
| `RhinoFileOpener.cs` | Strategy dispatch: extension -> Rhino import command. Handles `.3dm`, `.dwg`, `.dxf`, `.fbx`, `.obj`, `.stl`, `.ply`, `.3mf`, `.dae`, `.step`, `.iges` |
| `LayerInspector.cs` | Opens a file just to enumerate its layer tree (for `pollLayers` WS messages) |
| `RhinoConvertPreflight.cs` | Removes curves that fault `GetLength()` before ORBIT export (construction-layer degenerates) |
