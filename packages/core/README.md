# @geolibre/core

Domain types, the `.geolibre.json` project schema, and the Zustand store that
[GeoLibre](https://geolibre.app) is built on.

```bash
npm install @geolibre/core
```

```ts
import type { GeoLibreLayer, GeoLibreProject } from "@geolibre/core";
```

The package is ESM-only and ships TypeScript declarations. See
[`docs/project-format.md`](https://github.com/opengeos/GeoLibre/blob/main/docs/project-format.md)
for the project schema and
[`docs/architecture.md`](https://github.com/opengeos/GeoLibre/blob/main/docs/architecture.md)
for how the store drives the app.

MIT licensed.
