# Shared vector-tool golden fixtures

The GeoLibre vector geometry tools are implemented **twice**, in two languages,
and kept in sync by hand:

- **TypeScript / Turf.js** — `packages/processing/src/vector-tools.ts` (the
  client engine that runs in the browser main thread).
- **Python / GeoPandas + Shapely** —
  `backend/geolibre_server/geolibre_server/vector_ops.py` (the FastAPI sidecar
  engine). `apps/geolibre-desktop/src/lib/pyodide/vector_ops.generated.py` is an
  auto-generated verbatim copy of this file, so it is the *same* engine — there
  are two implementations to keep aligned, not three.

Both expose the same 19 tools and the **same canonical parameter names**, so a
single set of language-neutral fixtures can drive both. These fixtures are the
shared contract: each one is an `(input, parameters) → expected` case that both
engines must satisfy. Drift between the two engines is then caught by CI instead
of in the field. This directory is the "shared spec / golden fixtures" called
for by issue #352.

## Files

- `cases/*.json` — one golden case per file (see schema below).
- TS harness: `tests/vector-golden.test.ts` (run via `npm run test:frontend`).
- Python harness: `backend/geolibre_server/tests/test_vector_golden.py`
  (run via `npm run test:backend`).

Add a new shared case by dropping a `.json` file in `cases/`; both harnesses
glob the directory, so no test code changes are needed.

## Case schema

```jsonc
{
  "name": "select-by-value-numeric-gt",   // unique; also the file name
  "tool": "select-by-value",               // a key of the engines' dispatch table
  "description": "…",                       // human note, not asserted
  "input": { "type": "FeatureCollection", "features": [ … ] },   // required
  "overlay": { … } | null,                  // 2nd layer for clip/overlay/union/join
  "parameters": { "field": "pop", "operator": "gt", "value": "100" },
  "expect": {
    // Every field is optional; only the non-null ones are asserted, so a case
    // can assert as much or as little as the two engines genuinely agree on.
    "error": false,                 // when true: both engines must REJECT the
                                    //   input (TS produces no result layer;
                                    //   Python raises ValueError). No other
                                    //   field is checked.
    "featureCount": 2,              // exact output feature count
    "geometryTypes": ["Point"],     // multiset of output geometry types
                                    //   (compared order-insensitively)
    "properties": [ { … }, … ],     // expected per-feature `properties`,
                                    //   compared as an order-insensitive
                                    //   multiset with numeric tolerance
    "geometry": [ { … }, … ],       // expected per-feature geometry, compared
                                    //   in order, coordinates within tolerance
    "bbox": [w, s, e, n],           // expected bbox of the whole output
    "tolerance": 1e-9               // abs tolerance for geometry/bbox/number
                                    //   comparison (default 1e-9)
  }
}
```

## Two tiers of agreement

The two engines do **not** compute identical floating-point geometry for every
tool — Turf buffers in a planar approximation while GeoPandas reprojects to UTM,
Turf and Shapely use different simplification and Voronoi algorithms, etc. So a
fixture asserts at the strongest tier the two engines *actually* share:

- **Exact tier** — tools that are pure attribute/selection logic or carry input
  geometry through untouched (`select-by-value`, `select-by-location`,
  `attribute-join`, `spatial-join`), plus the hand-ported identical Chaikin
  `smooth` and the deterministic `bounding-box`. These assert `properties`
  and/or `geometry` exactly. This is where the "kept in sync with the backend"
  attribute logic lives, so it is asserted the hardest.
- **Structural tier** — geometry-approximation tools (`buffer`, `dissolve`,
  `aggregate` geometry, `centroids`, `convex-hull`, `simplify`, `clip`,
  `intersection`, `difference`, `union`, `voronoi`, `explode`). These assert
  `featureCount`, `geometryTypes`, and a loose `bbox` — the contract is that
  both engines agree on *shape and extent*, not on every vertex. `aggregate`
  additionally asserts its computed statistic `properties` exactly (the pandas
  numeric semantics are hand-replicated and must match), just not the dissolved
  geometry.

`reproject`'s client `run` is a deliberate no-op that defers to the Python
engine, so its fixtures are asserted by the Python harness only; the TS harness
skips any tool whose registry entry sets `requiresSidecar`.
