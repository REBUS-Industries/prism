# Prism Fixture Library

Lighting fixture types (GDTF) and placed instances (MVR) managed by `prism-fixtures-service`.

## Architecture

- **Service:** `prism-fixtures-service` on port **8769**, routed via nginx at `/api/fixtures`, `/api/gdtf-share`, `/api/mvr-import`.
- **Storage:** `${DATA_DIR}/fixtures/` on the shared `prism-data` volume.
- **Contracts:** `prism-shared/src/contracts/fixtures.ts` (wire types + DB migration `0012_fixtures_store.sql`).
- **Orbit upload:** TypeScript serialiser in `prism-shared/src/orbit/` — MVR workflow uploads `Orbit.Objects.Lighting.FixtureInstance` objects directly. Fixture **types** publish via `POST /api/fixtures/:id/publish-orbit` as `Orbit.Objects.Lighting.FixtureType` into the Orbit Fixtures project (`ORBIT_FIXTURES_PROJECT_ID`, default `0f2893eb28`).

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

Orbit fixture publish: **Settings → Orbit** (`orbit_server_url`, `orbit_token`) plus `ORBIT_FIXTURES_PROJECT_ID` on `prism-fixtures-service`. Published refs are stored on `definition.metadata.orbitFixtureRef`.

## Connectors

- **Rhino:** `prism:*` user strings on objects; send emits `FixtureInstance` alongside geometry.
- **UE5:** `orbit-cli` writes `.fixtures.json` sidecar; `UOrbitFixtureRegistry` loads it on import.
- **Vectorworks:** attribute key scaffold mirrors Rhino (Phase 6).

## Deploy (dev VM 212)

Split stack via `PRISM/infra/docker-compose.dev.yml` — `prism-fixtures` service + nginx router. No monolith route copy in `PRISM/server`.
