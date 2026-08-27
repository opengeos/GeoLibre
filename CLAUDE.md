# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Repository shape

GeoLibre is a single **npm workspaces monorepo** (`apps/*`, `packages/*`,
`workers/*`) plus two non-npm components: a Python FastAPI sidecar
(`backend/geolibre_server`) and a separate Python package (`python/`, the
`geolibre` Jupyter anywidget). One `npm install` at the root wires up every JS
workspace. Use **npm** (the repo tracks `package-lock.json`), Node **22+**.

The same React app ships three ways: native desktop via **Tauri v2**
(`apps/geolibre-desktop/src-tauri`), a browser web build served by nginx
(Docker), and embedded in Jupyter (the `python/` package bundles a build of the
web app into its wheel).

## Commands

```bash
npm run dev            # web dev server → http://localhost:5173
npm run tauri:dev      # desktop app (required for filesystem dialogs, local MBTiles, local raster reads)
npm run build          # production web build → apps/geolibre-desktop/dist/
npm run lite:build     # same, but DuckDB-WASM from jsDelivr — for hosts with a per-asset size cap
npm run tauri:build    # desktop installers → apps/geolibre-desktop/src-tauri/target/release/bundle/
npm run typecheck      # alias for the full build (tsc -b && vite build) — writes to dist/, not a pure type-check
npm run ci             # full local gate: build + frontend + worker + backend + rust check
```

Tests:

```bash
npm run test:frontend                              # node --test over tests/*.test.ts (tsx loader)
npm run test:frontend:coverage                     # same, plus a coverage summary (gated on a floor)
node --import tsx --test tests/<name>.test.ts      # a single frontend test file
npm run test:backend                               # pytest backend/geolibre_server/tests
npm run test:backend:coverage                      # same, plus pytest-cov (gated on a floor)
python -m pytest backend/geolibre_server/tests/test_x.py::test_y   # a single backend test
npm run test:worker                                # typecheck workers/viewer
npm run test:e2e                                   # Playwright smoke tests (e2e/) against the built web app
npm run check:rust                                 # cargo check the Tauri crate
cd python && pytest                                # the geolibre Python package's own suite
```

Setup notes that bite:

- Install the backend **`test`** extra or the vector/raster/SQL/ML tests skip
  themselves and CI is green but hollow:
  `pip install -e "backend/geolibre_server[test]"`.
- `npm run test:e2e` needs `npx playwright install chromium` once. It builds the
  app, serves it with `vite preview`, and drives it with Playwright; add specs
  under `e2e/`.
- Coverage floors act as a **ratchet** and the frontend report only counts files
  a test imports, so the first test for a big module can read as a regression.
  See [Coverage floors](docs/maintenance.md#coverage-floors) before touching a
  floor.

The `python/` package is built into a wheel via `npm run build:embed` (produces
`apps/geolibre-desktop/dist-embed`, consumed by `python/hatch_build.py`). Its
version is dynamic, sourced from `python/src/geolibre/__init__.py`.

## Pre-commit

`.pre-commit-config.yaml` includes a **local `npm-build` hook**, so
`pre-commit run` compiles the whole app — it is slow and can touch unrelated
build state. Scope it to the files you changed:
`pre-commit run --files <paths>`. Run it before pushing.

## Architecture (the parts that span files)

The app is **store-driven**. `@geolibre/core` holds the Zustand store, domain
types, and the `.geolibre.json` project schema — it is the single source of
truth. Data flows one way:

1. Data enters through the Add Data menus, Tauri dialogs, the browser file
   picker, drag-and-drop, or a plugin control.
2. Local vector files MapLibre can't render directly are converted to GeoJSON
   in-browser by **DuckDB-WASM Spatial** (`INSTALL spatial; LOAD spatial;` →
   `ST_Read`; GeoParquet via the Parquet reader; zipped Shapefiles via `shpjs`
   with a DuckDB fallback; KMZ unzipped client-side), then `addGeoJsonLayer`.
3. Tile/service/raster/ArcGIS/MBTiles/plugin layers become `GeoLibreLayer`
   records.
4. `MapCanvas` subscribes to `layers`; `MapController.syncLayers`
   (`@geolibre/map`) reconciles MapLibre sources/layers and the layer control.
   **You don't mutate MapLibre directly from UI** — change store state and let
   sync apply it.

Rendering is MapLibre GL JS in the webview, with **deck.gl** for
raster/point-cloud/3D overlays.

**Packages:** `@geolibre/core` (types, project format, store) · `@geolibre/map`
(MapLibre lifecycle + layer sync) · `@geolibre/ui` (shadcn-style primitives) ·
`@geolibre/processing` (client-side algorithm registry) · `@geolibre/plugins`
(plugin interface + built-in plugins) · `@geolibre/embed` (typed iframe embed
client) · `geolibre-desktop` (shell layout, Tauri I/O, composition).

**Plugins:** built-in plugins live in `packages/plugins/src/plugins/`, are
exported from that package's `index.ts`, and registered in
`apps/geolibre-desktop/src/hooks/usePlugins.ts`. External plugins load from zips
or a `plugin.json` manifest; bundled drop-ins under
`apps/geolibre-desktop/public/plugins/<id>/` bake into both web and desktop
builds. See `docs/plugin-api.md`.

**Python sidecar** (`backend/geolibre_server`, FastAPI on `127.0.0.1:8765`):
backs the Whitebox toolbox, format Conversion tools, and Raster tools (rasterio).
The desktop app starts it on demand. It is **optional** — Vector tools run
client-side with Turf.js and only use the sidecar's `/vector` endpoints
(GeoPandas/Shapely) when the optional `vector` extra is installed; the dialog
falls back to the client engine via `/vector/status`. Optional extras:
`conversion`, `vector`, `raster`. Some conversions (PMTiles, Whitebox) are
amd64-only. The browser build proxies the sidecar at `/sidecar` (same-origin, no
CORS), confined to `GEOLIBRE_CONVERSION_ROOTS` (default `/data`). Local MBTiles
use a custom MapLibre protocol backed by Tauri commands.

**MCP server** (`python/src/geolibre/mcp/`, the `geolibre-mcp` console script):
a headless stdio MCP server that authors `.geolibre.json` files. It is layered so
nothing duplicates: `project.py` *builds* pieces (a layer, a plugin-state blob),
`authoring.py` *applies* them to a whole project (add/remove/restyle a layer,
move the camera, compose the legend/colorbar/swipe controls), and both `Map` and
the MCP tools delegate to `authoring.py`. `server.py` is the only module that
imports the `mcp` SDK (optional extra `geolibre[mcp]`), and `workspace.py`
confines every path to `GEOLIBRE_MCP_ROOTS`/`--root` the way the sidecar confines
to `GEOLIBRE_CONVERSION_ROOTS`. `python/tests/test_mcp_server.py` skips itself
without the SDK, so `publish-python.yml` installs `mcp` explicitly — drop it
and the server ships untested.

## Conventions

- Never commit directly to `main`; branch and open a PR.
- Tauri CSP allowlists tile/style hosts (OpenFreeMap, CARTO) — new external
  map/tile hosts must be added there. Map/tile-host CORS for selected release
  assets is handled by a dev-server raster proxy.
- For MapLibre control styling fixes, add scoped overrides in
  `apps/geolibre-desktop/src/index.css`, never edit `node_modules`.
- UI strings are translatable via **react-i18next**; catalogs live in
  `apps/geolibre-desktop/src/i18n/locales/*.json` (`en.json` is the source of
  truth, typed by `i18next.d.ts`). Use `t()` for new user-facing strings. The UI
  mirrors for right-to-left locales, so style new components with Tailwind's
  logical utilities (`ms-`/`me-`/`ps-`/`pe-`/`text-start`/`border-s`/`start-`…),
  not the physical `ml-`/`left-` forms. **Read `docs/i18n.md` in full before any
  i18n work** — skipping it is the most common source of locale bugs.
- **Some things upstream doesn't export are mirrored by hand, and drift fails
  silently.** Before bumping `maplibre-gl`, any `maplibre-gl-*` package,
  `geolibre-wasm`, or `@tauri-apps/plugin-http` — including Dependabot PRs — read
  [`docs/maintenance.md`](docs/maintenance.md) and run the frontend suite. That
  page also covers the coverage floors, the `npm audit` allowlist, the npm
  publish layout for `@geolibre/core`/`@geolibre/map`, the committed
  `backend/geolibre_server/uv.lock`, and the generated files (Whitebox menu
  catalog, `npm run i18n:tools`, the `skills/geolibre/` agent skill) that must be
  regenerated or updated in the same PR.
- Reference docs: `docs/architecture.md`, `docs/project-format.md`,
  `docs/plugin-api.md`, `docs/python.md`, `docs/mcp.md`, `docs/agent-skill.md`,
  `docs/i18n.md`, `docs/maintenance.md`, `docs/contributing.md`.
