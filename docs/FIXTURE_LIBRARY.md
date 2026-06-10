# Prism Fixture Library

Lighting fixture types (GDTF) and placed instances (MVR) managed by `prism-fixtures-service`.

## Architecture

- **Service:** `prism-fixtures-service` on port **8769**, routed via nginx at `/api/fixtures`, `/api/gdtf-share`, `/api/mvr-import`.
- **Storage:** `${DATA_DIR}/fixtures/` on the shared `prism-data` volume.
- **Contracts:** `prism-shared/src/contracts/fixtures.ts` (wire types + DB migration `0012_fixtures_store.sql`).
- **Orbit upload:** TypeScript serialiser in `prism-shared/src/orbit/` — MVR workflow uploads `Orbit.Objects.Lighting.FixtureInstance` objects directly.

## Data model

| Concept | Source | Notes |
|---------|--------|-------|
| **FixtureType** | GDTF only | Parts, DMX modes, beams, wheels, models |
| **FixtureInstance** | MVR / connectors | Patch, mode, transform; references a FixtureType |

Part tags: `ORIGIN`, `CLAMP`, `BASE`, `YOKE`, `HEAD`, `LENS`, `CELL`, `BEAM`.

## API (scopes)

| Scope | Use |
|-------|-----|
| `fixtures:read` | List / detail / preview |
| `fixtures:write` | Create / edit / IES |
| `fixtures:delete` | Soft-delete types |
| `fixtures:import` | GDTF / MVR import |

## Admin UI

| Route | Purpose |
|-------|---------|
| `/fixtures` | Library grid |
| `/fixtures/:id` | Editor (DMX, parts, IES, datum pivots) |
| `/fixtures/import` | GDTF file + GDTF-Share wizard |
| `/mvr-import` | MVR parse → ORBIT upload |

GDTF-Share credentials: **Settings → GDTF-Share** (`gdtf_share_username`, `gdtf_share_password`).

## Connectors

- **Rhino:** `prism:*` user strings on objects; send emits `FixtureInstance` alongside geometry.
- **UE5:** `orbit-cli` writes `.fixtures.json` sidecar; `UOrbitFixtureRegistry` loads it on import.
- **Vectorworks:** attribute key scaffold mirrors Rhino (Phase 6).

## Deploy (dev VM 212)

Split stack via `PRISM/infra/docker-compose.dev.yml` — `prism-fixtures` service + nginx router. No monolith route copy in `PRISM/server`.
