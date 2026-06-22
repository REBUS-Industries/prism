# Library list/detail enrichment (fixtures + models)

When serializing `GET /api/fixtures`, `GET /api/fixtures/:id`, `GET /api/models`,
or `GET /api/models/:id`, use **`@rebus-industries/prism-shared/library`**
(added in prism-shared **1.0.6**):

```typescript
import {
  toFixtureTypeDetail,
  toFixtureTypeSummary,
  toModelTypeDetail,
  toModelTypeSummary,
} from '@rebus-industries/prism-shared/library';
import { loadIntegrationSettings } from '@rebus-industries/prism-shared/db';

// Fixtures list row
const settings = await loadIntegrationSettings(db);
return toFixtureTypeSummary(
  {
    ...dbRow,
    hasPreview: Boolean(dbRow.previewModelId),
    definition: dbRow.definition,
  },
  versionRows.map((v) => ({
    ...v,
    isActive: v.id === dbRow.activeVersionId,
  })),
  settings,
);

// Models detail
return toModelTypeDetail(modelRow, versionRows, settings);
```

Each enriched row exposes:

| Field | Fixtures | Models |
|-------|----------|--------|
| `previewUrl` | Active preview GLB path | Active preview GLB path |
| `orbitUrl` | From `definition.metadata.orbitFixtureRef` | From `definition.metadata.orbit` |
| `versions[]` | `downloadedAt` + `previewUrl` per revision | `createdAt` + `previewUrl` + `orbitUrl` per revision |

Bump the service's `@rebus-industries/prism-shared` dependency to `^1.0.6` before
deploying.
