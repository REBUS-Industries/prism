# UniFi gateway rules — Visualiser TURN

Date created: 2026-05-27 | Last updated: 2026-05-27 (relay range narrowed to `52000-56999`; DNS A record live)

Port-forward rules the **UniFi gateway** (`10.0.1.1`, SSH `root`,
password rotated 2026-05-11 — see `CLAUDE.md`) needs for coturn on
VM 212 to be reachable from the public internet.

> **2026-06-16:** Migrated from VM 211. Update existing rules that still
> point at `10.0.200.211` to `10.0.200.212`.

Apply via **UniFi Console → Settings → Internet → Port Forwarding**.
All rules target the `185.48.165.165` WAN alias (the same one Caddy /
Speckle / PRISM use); do **not** apply them to the management alias
`185.48.165.164`.

---

## Rules to add

| Name | Protocol | Outside Port | Inside IP | Inside Port |
|---|---|---|---|---|
| `coturn-stun-udp` | UDP | `3478` | `10.0.200.212` | `3478` |
| `coturn-stun-tcp` | TCP | `3478` | `10.0.200.212` | `3478` |
| `coturn-tls` | TCP | `5349` | `10.0.200.212` | `5349` |
| `coturn-relay-udp` | UDP | `52000-56999` | `10.0.200.212` | `52000-56999` |

The relay range is intentionally narrowed away from coturn's default
`49152-65535` to **avoid WireGuard's `51820/udp`**, which is forwarded
elsewhere on the REBUS network. The current `52000-56999` window is
well above the WG listener and well inside the IANA Dynamic /
Ephemeral block; 5000 ports is far more than the realistic concurrency
ceiling (~20 simultaneous Pixel Streaming sessions, since each one
needs a GPU on the workstation side). Any further change here MUST
be paired with matching `min-port=` / `max-port=` lines in
`turnserver.conf`.

---

## Until these rules are applied

The Phase G `POST /api/visualiser/streams` endpoint already returns
valid TURN credentials in the `turn` field (as long as `TURN_SECRET`
is set in PRISM's env). However, **the browser cannot actually reach
the relay**.

The symptom is consistent and easy to recognise:
- ICE gathering reaches `srflx` candidates only (no `relay`).
- The Pixel Streaming player UI sits on "Connecting..." for ~30 s.
- Browser devtools network log shows aborted UDP candidate pairs.
- Server-side `docker logs coturn` is empty (no inbound connection
  reached the listener).

Confirmation that the rules are in effect:

```bash
# From any host with public-internet egress (NOT inside the REBUS LAN):
nc -uvz 185.48.165.165 3478   # expect: succeeded
nc -uvz 185.48.165.165 5349   # expect: succeeded (only after TLS step in SETUP_NOTES)
```

Inside the REBUS LAN this test will instead resolve via internal AD
DNS to `10.0.200.212:3478` directly, which is unrelated — make sure
the smoke test runs from off-LAN (a phone on cellular works fine).

---

## Optional hardening

The current `52000-56999` range (5000 ports) is the deliberate
production setting — it dodges WireGuard's `51820/udp` and gives
plenty of headroom for the realistic ~20-concurrent ceiling. There is
no need to narrow further unless port-count auditing becomes a
compliance requirement.

If you do narrow further, update **both** the UniFi rule AND the
`min-port=` / `max-port=` lines in `turnserver.conf`, then restart
coturn. Do not narrow below ~256 ports — Pixel Streaming uses
multiple data channels per session and a tight range can cause
`Allocate` to fail under modest load. Also keep clear of `51820/udp`
(WireGuard) when picking any new boundary.
