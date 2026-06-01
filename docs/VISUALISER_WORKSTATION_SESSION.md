# PRISM Visualiser — workstation session persistence

How to keep the GPU-backed PRISM Visualiser running on a render
workstation (e.g. `RB-DA2-PC01`) **without an operator babysitting an RDP
session**, and the one rule that everyone touching the box must follow.

---

## TL;DR

- **Enable auto-logon** of the local render account so a persistent,
  GPU-backed console session exists at every boot.
- **Connect with RDP/Parsec for maintenance, then _Disconnect_.**
  **NEVER click _Log off / Sign out_** — that destroys the session and
  kills the agent + Unreal Engine.
- The PRISM agent already runs interactively and needs no change.

---

## Why the visualiser dies on log off

The PRISM agent is installed as an **interactive** Task Scheduler task
(`PRISM.Agent`, `LogonType=Interactive`, triggers *AtLogOn* + *AtStartup*,
runs as the local workstation account). When a visualisation starts, the
agent spawns:

```
PRISM.Agent.exe            (interactive session, e.g. session 1/2)
└─ prism-visualiser.exe    (same session)
   └─ UnrealEditor-Cmd.exe -game -windowed -PixelStreamingURL=…   (same session)
```

Because UE is a **child of the agent**, it runs in the **same Windows
session** as the agent. A real interactive desktop session has access to
the discrete GPU (the **RTX 6000 Ada** on PC01), which is what UE needs to
render and Pixel-Stream.

Key facts (verified live on PC01):

| Action on the session | Session survives? | Agent + UE survive? | GPU retained? |
|---|---|---|---|
| **Disconnect** (close RDP / Parsec)   | ✅ yes | ✅ yes | ✅ yes — UE keeps rendering on the RTX |
| **Log off / Sign out**                | ❌ no  | ❌ no  | — session is torn down |
| **Reboot**                            | ❌ no  | ❌ (until logon) | — needs auto-logon to come back |

So the failure the operators see — *"visualiser unavailable after I logged
off"* — is plain Windows session teardown. It is **not** a session‑0
service problem: the agent is already interactive and already targets the
GPU session correctly. The missing piece is a **persistent session that is
never logged off** and that **comes back after a reboot**.

> A UE process launched from a non‑interactive/SSH (session 0) context has
> no desktop/GPU and dies instantly. That is why everything must stay in
> the auto‑logon interactive session.

---

## The fix

### 1. Auto-logon (primary, reboot-safe)

Enable auto-logon for the **local** render account (`LocalUser` on PC01 —
a local workstation account, *not* a domain account). On every boot
Windows creates the console session automatically, the `PRISM.Agent`
*AtLogOn* trigger fires inside it, and UE inherits that GPU-backed session.

Use the bundled helper (ships in `C:\Program Files\PRISM.Agent\install\`):

```powershell
# From an ELEVATED PowerShell on the workstation.

# Step A — PREPARE (safe any time, no boot impact). Backs up the Winlogon
# registry key, sets the non-secret values, leaves auto-logon OFF:
& 'C:\Program Files\PRISM.Agent\install\Set-VisualiserAutoLogon.ps1'

# Step B — ENABLE (operator who knows the LocalUser password runs ONE):

#  Preferred — encrypted LSA secret via Sysinternals Autologon:
& 'C:\Program Files\PRISM.Agent\install\Set-VisualiserAutoLogon.ps1' `
    -SysinternalsAutologon 'C:\Tools\Autologon64.exe' -Password '<LocalUser password>'

#  Fallback — plaintext registry DefaultPassword (LAN-only render box):
& 'C:\Program Files\PRISM.Agent\install\Set-VisualiserAutoLogon.ps1' -Password '<LocalUser password>'
```

The helper **always exports the Winlogon key to a timestamped `.reg`**
under `C:\ProgramData\PRISM.Agent\backups\` before changing anything.

To turn it back off:

```powershell
& 'C:\Program Files\PRISM.Agent\install\Set-VisualiserAutoLogon.ps1' -Disable
```

**Credential note:** prefer **Sysinternals Autologon**
(<https://learn.microsoft.com/sysinternals/downloads/autologon>) — it
stores the password as an encrypted **LSA secret** rather than a plaintext
`DefaultPassword` registry value. Use a **local** account only; never store
domain-admin credentials on the workstation.

### 2. The golden rule — Disconnect, never Log off

Once auto-logon is on, the render session lives on its own. For
maintenance:

- **RDP:** do your work, then **close the window / choose *Disconnect***.
  Do **not** use Start → user → *Sign out*.
- **Parsec:** just close the Parsec client (that is a disconnect). Don't
  sign out of Windows.

If someone *does* log off by accident: the quickest recovery is to **RDP
back in** (the `PRISM.Agent` *AtLogOn* trigger re-fires and the agent
returns), or **reboot** (auto-logon recreates the session). Any
in-progress stream is lost and must be restarted from the portal.

### 3. (Optional) tscon keep-to-console watchdog

A *disconnected* RDP session already keeps the GPU on this hardware, so
auto-logon + the disconnect rule is normally sufficient. Fleets that want
the GPU session pinned to the **physical console** at all times can install
an optional watchdog:

```powershell
& 'C:\Program Files\PRISM.Agent\install\Install-VisualiserSessionKeepAlive.ps1'
# remove with:  … -Uninstall
```

It registers `PRISM.VisualiserSessionKeepAlive` (SYSTEM, at startup + every
2 min). When the render account's session is **disconnected** and not
already on the console, it runs `tscon <id> /dest:console` to re-home the
session to the console **without logging it off** (processes keep running).
It never touches a session that is actively connected, so an operator who
is currently RDP'd in is never kicked.

---

## Validation procedure

You cannot validate GPU streaming from an SSH/non-interactive session
(no GPU/desktop there). Validate interactively:

1. **Start:** RDP/Parsec into PC01, start a visualiser session from the
   portal, and confirm the stream renders in the browser viewer.
2. **Disconnect test:** *Disconnect* (don't log off). The existing stream
   should keep working; start a **new** visualiser run and confirm it also
   streams while you're disconnected.
3. **Reboot test (auto-logon):** reboot PC01. After boot — with **no one
   logged in** — confirm `query session` shows the render account on the
   console, the `PRISM.Agent` task is *Running*, and a freshly-started
   visualiser run streams.

Quick health checks over SSH (these don't need the GPU):

```powershell
query session                                   # render account should be Active/Disc, never absent
Get-ScheduledTask PRISM.Agent | % State         # Running
nvidia-smi --query-compute-apps=pid,process_name --format=csv   # UnrealEditor-Cmd.exe present during a run
```

---

## Reference — PC01 baseline (verified 2026-06-01)

- GPU: **NVIDIA RTX 6000 Ada Generation** (+ Parsec Virtual Display Adapter, ASPEED onboard).
- Agent: `PRISM.Agent` scheduled task, `LogonType=Interactive`, `RunLevel=Highest`,
  triggers *AtLogOn(LocalUser)* + *AtStartup*, exe
  `C:\Program Files\PRISM.Agent\PRISM.Agent.exe`. **No Windows service.**
- Auto-logon at time of writing: **disabled** (`AutoAdminLogon=0`) — this is
  the gap this runbook closes.
- Account: `LocalUser` (local workstation account on `RB-DA2-PC01`).
