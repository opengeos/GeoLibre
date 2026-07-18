# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository shape

GeoLibre is a single **npm workspaces monorepo** (`apps/*`, `packages/*`, `workers/*`) plus two non-npm components: a Python FastAPI sidecar (`backend/geolibre_server`) and a separate Python package (`python/`, the `geolibre` Jupyter anywidget). One `npm install` at the root wires up every JS workspace. Use **npm** (the repo tracks `package-lock.json`), Node **22+**.

The same React app ships three ways: native desktop via **Tauri v2** (`apps/geolibre-desktop/src-tauri`), a browser web build served by nginx (Docker), and embedded in Jupyter (the `python/` package bundles a build of the web app into its wheel).

## Commands

```bash
npm run dev            # web dev server → http://localhost:5173
npm run tauri:dev      # desktop app (required for filesystem dialogs, local MBTiles, local raster reads)
npm run build          # production web build → apps/geolibre-desktop/dist/
npm run tauri:build    # desktop installers → apps/geolibre-desktop/src-tauri/target/release/bundle/
npm run typecheck      # alias for the full build (tsc -b && vite build) — writes to dist/, not a pure type-check
npm run ci             # full local gate: build + frontend + worker + backend + rust check
```

Tests:

```bash
npm run test:frontend                              # node --test over tests/*.test.ts (tsx loader)
npm run test:frontend:coverage                     # same, plus a per-file coverage summary (Node built-in)
node --import tsx --test tests/<name>.test.ts      # a single frontend test file
npm run test:backend                               # pytest backend/geolibre_server/tests
npm run test:backend:coverage                      # same, plus a pytest-cov term-missing report
python -m pytest backend/geolibre_server/tests/test_x.py::test_y   # a single backend test
npm run test:worker                                # typecheck workers/viewer
npm run test:e2e                                    # Playwright smoke tests (e2e/) against the built web app
npm run check:rust                                 # cargo check the Tauri crate
```

The `:coverage` variants run the same suites and print a coverage summary; CI
runs them so every build reports coverage. They are now **gated on a floor**:
`test:frontend:coverage` fails below 78% lines / 78% branches / 63% functions,
and `test:backend:coverage` fails below 55% (`--cov-fail-under`). The floors sit
a few points under the current numbers as a **ratchet** — regressions fail CI,
and when coverage rises comfortably above a floor, raise the floor to lock in the
gain. The frontend
report only counts files a test actually imports, so a module with no test does
not appear at all rather than as 0%. The backend coverage run (and `npm run ci`,
which calls the `:coverage` variants) needs `pytest-cov` from the backend `dev`
extra. Install the **`test`** extra to run the *full* backend suite — without
the optional engines (geopandas/rasterio/sedona/httpx) the vector/raster/SQL/ML
tests skip themselves and CI is green but hollow:
`pip install -e "backend/geolibre_server[test]"`.

`npm run test:e2e` builds the web app, serves it with `vite preview`, and drives
it with Playwright (`@playwright/test`). First run: `npx playwright install
chromium`. The webServer reuses an already-running preview locally and rebuilds
in CI; add specs under `e2e/`.

Dependencies are watched two ways: **Dependabot** (`.github/dependabot.yml`)
opens grouped weekly update PRs for npm, pip (backend + `python/`), cargo, and
Actions, and the CI **`audit` job** runs `npm audit --audit-level=high`
(blocking) plus a non-blocking `pip-audit` of the resolved backend environment.

The `python/` package has its own pytest suite (`cd python && pytest`) and is built into a wheel via `npm run build:embed` (produces `apps/geolibre-desktop/dist-embed`, consumed by `python/hatch_build.py`). Its version is dynamic, sourced from `python/src/geolibre/__init__.py`.

## Pre-commit

`.pre-commit-config.yaml` includes a **local `npm-build` hook**, so `pre-commit run` compiles the whole app — it is slow and can touch unrelated build state. Scope it to the files you changed: `pre-commit run --files <paths>`. Run it before pushing.

## Architecture (the parts that span files)

The app is **store-driven**. `@geolibre/core` holds the Zustand store, domain types, and the `.geolibre.json` project schema — it is the single source of truth. Data flows one way:

1. Data enters through the Add Data menus, Tauri dialogs, the browser file picker, drag-and-drop, or a plugin control.
2. Local vector files that MapLibre can't render directly are converted to GeoJSON in-browser by **DuckDB-WASM Spatial** (`INSTALL spatial; LOAD spatial;` → `ST_Read`; GeoParquet via the Parquet reader; zipped Shapefiles via `shpjs` with a DuckDB fallback; KMZ unzipped client-side). The result calls `addGeoJsonLayer`.
3. Tile/service/raster/ArcGIS/MBTiles/plugin layers become `GeoLibreLayer` records.
4. `MapCanvas` subscribes to `layers`; `MapController.syncLayers` (`@geolibre/map`) reconciles MapLibre sources/layers and the layer control. **You don't mutate MapLibre directly from UI** — you change store state and let sync apply it.

Rendering is MapLibre GL JS in the webview, with **deck.gl** for raster/point-cloud/3D overlays.

**Packages:** `@geolibre/core` (types, project format, store) · `@geolibre/map` (MapLibre lifecycle + layer sync) · `@geolibre/ui` (shadcn-style primitives) · `@geolibre/processing` (client-side algorithm registry) · `@geolibre/plugins` (plugin interface + built-in plugins) · `geolibre-desktop` (shell layout, Tauri I/O, composition).

**Plugins:** Built-in plugins live in `packages/plugins/src/plugins/`, are exported from that package's `index.ts`, and registered in `apps/geolibre-desktop/src/hooks/usePlugins.ts`. External plugins load from zips or a `plugin.json` manifest; bundled drop-ins under `apps/geolibre-desktop/public/plugins/<id>/` bake into both web and desktop builds. See `docs/plugin-api.md`.

**Python sidecar** (`backend/geolibre_server`, FastAPI on `127.0.0.1:8765`): backs the Whitebox toolbox, format Conversion tools, and Raster tools (rasterio). The desktop app starts it on demand. It is **optional** — Vector tools (Processing → Vector) run client-side with Turf.js and only use the sidecar's `/vector` endpoints (GeoPandas/Shapely) when the optional `vector` extra is installed; the dialog falls back to the client engine via `/vector/status`. Optional extras: `conversion`, `vector`, `raster`. Some conversions (PMTiles, Whitebox) are amd64-only.

The browser build proxies the sidecar at `/sidecar` (same-origin, no CORS); confined to `GEOLIBRE_CONVERSION_ROOTS` (default `/data`). Local MBTiles use a custom MapLibre protocol backed by Tauri commands.

## Conventions

- Never commit directly to `main`; branch and open a PR.
- Tauri CSP allowlists tile/style hosts (OpenFreeMap, CARTO) — new external map/tile hosts must be added there.
- Map/tile-host CORS for selected release assets is handled by a dev-server raster proxy.
- For MapLibre control styling fixes, add scoped overrides in `apps/geolibre-desktop/src/index.css`, never edit `node_modules`.
- The Processing **menu** (`ProcessingMenu.tsx`) renders from a checked-in, auto-generated catalog, `apps/geolibre-desktop/src/lib/whitebox-menu-catalog.ts` (do not hand-edit). Whenever `geolibre-wasm` is bumped (in `packages/processing/package.json`) — including Dependabot PRs — run `node scripts/gen-whitebox-menu-catalog.mjs` and commit the result, or new/renamed WASM tools silently miss the menu (the Processing **dialog** lists them dynamically, so the gap only shows in the menu).
- `MAX_VECTOR_PMTILES_ZOOM` (`packages/processing/src/wasm-convert.ts`) mirrors the deepest zoom `vector_to_pmtiles` accepts (18 — past it the tool exits with `validation error: max_zoom must be <= 18`). The cap lives inside the WASM binary and is not exported, so whenever `geolibre-wasm` is bumped — including Dependabot PRs — re-check it. If it drifts, the browser's Vector to PMTiles either refuses a zoom the tiler would now accept, or accepts one it will reject after the user has waited. Note this is **not** the sidecar's cap: freestiler allows 24 (`MAX_PMTILES_ZOOM` in `ConversionDialog.tsx`, mirroring `backend/geolibre_server/geolibre_server/app/conversion.py`), and the dialog validates against whichever engine is about to run. `tests/wasm-convert.test.ts` ("accepts the documented maximum zoom and rejects one deeper") fails in CI if the mirror drifts, so running the frontend suite after a bump is enough to catch it.
- `MAX_VECTOR_BYTES` (`packages/plugins/src/plugins/source-coop-api.ts`) mirrors `MAX_REMOTE_FILE_BYTES`, an **internal, unexported** constant in `maplibre-gl-vector` (2 GiB — DuckDB-WASM holds remote file sizes in 32 bits). It cannot be imported, so whenever `maplibre-gl-vector` is bumped (in `packages/plugins/package.json`) — including Dependabot PRs — re-check `src/lib/utils/remote.ts` in that package and update the mirror if it moved. If it drifts, the Source Cooperative browser silently blocks GeoParquet the engine could now open, or offers an Add that is certain to fail. Updating the constant is enough: the limit the user is shown is rendered from it, not written into the copy.
- `MAP_PANEL_SELECTOR` (`apps/geolibre-desktop/src/components/layout/RecordVideoDialog.tsx`) mirrors the **rendered** control class names from `maplibre-gl-components` — `maplibre-gl-html-control`, `maplibre-gl-legend`, `maplibre-gl-colorbar` — so the Record Video "Include map panels" option can rasterize those on-map overlays into the recording. These are the display elements, deliberately **not** the `*-gui-control` authoring editors. The classes are internal and unexported, so whenever `maplibre-gl-components` is bumped (in `packages/plugins/package.json`) — including Dependabot PRs — re-check them against the rendered controls and update the selector if they moved. If a class drifts, the option silently stops burning that panel into the video (or the checkbox never appears) with no build error.
- `propertySpecFor` (`packages/core/src/expressions.ts`) fabricates the **unexported** `StylePropertySpecification` shape that `@maplibre/maplibre-gl-style-spec`'s `createExpression` uses for expected-result-type enforcement (the Expression Builder's filter → boolean / color checks). The cast hides any contract change from the compiler, so whenever `@maplibre/maplibre-gl-style-spec` is bumped (including Dependabot PRs) run the frontend suite — the "enforces an expected result type" test in `tests/expressions.test.ts` fails if the shape stops being honored.
- UI strings are translatable via **react-i18next**; catalogs live in `apps/geolibre-desktop/src/i18n/locales/*.json` (`en.json` is the source of truth, typed by `i18next.d.ts`). Use `t()` for new user-facing strings; a `?locale`/`?lang` query param sets the embed language. The UI mirrors for right-to-left locales (Arabic), so style new components with Tailwind's logical utilities (`ms-`/`me-`/`ps-`/`pe-`/`text-start`/`border-s`/`start-`…), not the physical `ml-`/`left-` forms. See `docs/i18n.md`.
- Reference docs: `docs/architecture.md`, `docs/project-format.md`, `docs/plugin-api.md`, `docs/python.md`, `docs/i18n.md`, `docs/contributing.md`.
