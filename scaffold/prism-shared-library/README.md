# prism-shared library response serializers (v1.0.6)

These files are a **reference copy** for upstreaming into
[`REBUS-Industries/prism-shared`](https://github.com/REBUS-Industries/prism-shared).

Polyrepo services (`prism-fixtures-service`, `prism-models-service`) should:

1. Merge the matching changes into `prism-shared` (contracts + `src/library/`).
2. Publish **`@rebus-industries/prism-shared@1.0.6`**.
3. Wire list/detail handlers — see [`../LIBRARY_API_RESPONSES.md`](../LIBRARY_API_RESPONSES.md).

Files in this folder mirror:

| Path | Purpose |
|------|---------|
| `src/contracts/fixtures.ts` | Extended fixture list/detail + version types |
| `src/contracts/models.ts` | Model library wire types |
| `src/library/responses.ts` | `toFixtureTypeSummary`, `toModelTypeDetail`, preview/orbit URL helpers |
| `src/orbit/motionRig.ts` | Normalise pan/tilt for Orbit FixtureType publish |
