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
npm run lite:build     # same, but DuckDB-WASM from jsDelivr — for hosts with a per-asset size cap
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
not appear at all rather than as 0%.

That last point is the one that bites: writing the *first* test for a large
untested module reads as a coverage **regression**, because the module and
everything it imports enter the denominator at once. GeoLibre#1784 added a test
that imported `usePlugins.ts` and so pulled in the whole built-in plugin
registry, 39 files, dropping function coverage 72.90% → 60.36% and reddening
`main`. The fix is to test against a leaf module rather than to lower the floor
(GeoLibre#1888 extracted `lib/plugin-layer-queries.ts`; `geo-editor-geometry.ts`
in `@geolibre/plugins` is the same pattern). Check what a new test *transitively*
imports before assuming a coverage drop means the code got worse.

`test:frontend:coverage` runs through `scripts/coverage-check.mjs` rather than
calling `node --test` directly. Node still enforces all three floors; the wrapper
only re-measures once when **line** coverage alone comes up short with every test
passing. Line coverage is nondeterministic on CI (GeoLibre#1889: two runs over
byte-identical sources reported 81.82% and 76.47%, 114 of 444 files differing on
lines and *none* on branches or functions), and it is not reproducible locally on
either Node 22 or 26. Branch and function shortfalls, and any test failure, fail
on the spot with no retry, so a real regression still fails fast. `classify()` is
exported and covered by `tests/coverage-check.test.ts` — change the retry policy
there, not by loosening a floor. If the retry starts firing regularly, fix the
measurement instead of widening the mitigation.

The backend coverage run (and `npm run ci`,
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
Actions, and the CI **`audit` job** runs `npm run audit:ci`
(blocking) plus a non-blocking `pip-audit` of the resolved backend environment.
`audit:ci` is `scripts/audit-check.mjs`, a thin wrapper over `npm audit
--omit=dev` that still fails on every high/critical advisory *except* the ones
listed in its `ALLOWLIST`. The wrapper exists because plain `npm audit` cannot
accept a single finding, so one unpatchable transitive advisory reddens every PR
until upstream ships a fix — which for an unmaintained leaf package may be never.
Only allowlist an advisory when there is **no patched version to upgrade to** and
the vulnerable code is **unreachable from a GeoLibre runtime path**, and say why
on both counts in the entry. Anything upgradeable gets upgraded instead. Stale
entries print a warning rather than failing, since the advisory database is a
live service and a transient omission must not redden an unrelated PR.

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

**Packages:** `@geolibre/core` (types, project format, store) · `@geolibre/map` (MapLibre lifecycle + layer sync) · `@geolibre/ui` (shadcn-style primitives) · `@geolibre/processing` (client-side algorithm registry) · `@geolibre/plugins` (plugin interface + built-in plugins) · `@geolibre/embed` (typed iframe embed client, the one package published to npm — `.github/workflows/publish-embed.yml` publishes it on each GitHub Release, skipping a version already there) · `geolibre-desktop` (shell layout, Tauri I/O, composition).

**Plugins:** Built-in plugins live in `packages/plugins/src/plugins/`, are exported from that package's `index.ts`, and registered in `apps/geolibre-desktop/src/hooks/usePlugins.ts`. External plugins load from zips or a `plugin.json` manifest; bundled drop-ins under `apps/geolibre-desktop/public/plugins/<id>/` bake into both web and desktop builds. See `docs/plugin-api.md`.

**Python sidecar** (`backend/geolibre_server`, FastAPI on `127.0.0.1:8765`): backs the Whitebox toolbox, format Conversion tools, and Raster tools (rasterio). The desktop app starts it on demand. It is **optional** — Vector tools (Processing → Vector) run client-side with Turf.js and only use the sidecar's `/vector` endpoints (GeoPandas/Shapely) when the optional `vector` extra is installed; the dialog falls back to the client engine via `/vector/status`. Optional extras: `conversion`, `vector`, `raster`. Some conversions (PMTiles, Whitebox) are amd64-only.

The browser build proxies the sidecar at `/sidecar` (same-origin, no CORS); confined to `GEOLIBRE_CONVERSION_ROOTS` (default `/data`). Local MBTiles use a custom MapLibre protocol backed by Tauri commands.

**MCP server** (`python/src/geolibre/mcp/`, the `geolibre-mcp` console script): a headless stdio MCP server that authors `.geolibre.json` files. It is layered so nothing duplicates: `project.py` *builds* pieces (a layer, a plugin-state blob), `authoring.py` *applies* them to a whole project (add/remove/restyle a layer, move the camera, compose the legend/colorbar/swipe controls), and both `Map` and the MCP tools delegate to `authoring.py` — so a change to how a control is composed lands in one place. `server.py` is the only module that imports the `mcp` SDK (optional extra `geolibre[mcp]`), and `workspace.py` confines every path to `GEOLIBRE_MCP_ROOTS`/`--root` the way the sidecar confines to `GEOLIBRE_CONVERSION_ROOTS`. `python/tests/test_mcp_server.py` skips itself without the SDK, so `publish-python.yml` installs `mcp` explicitly — drop it and the server ships untested.

## Conventions

- Never commit directly to `main`; branch and open a PR.
- **`backend/geolibre_server/uv.lock` is committed** (the root `.gitignore` ignores `uv.lock` everywhere else and negates it for this one path). That project is bundled into the desktop installers and launched with `uv run --frozen --project <resource dir>` from `src-tauri/src/lib.rs` — a directory the user cannot write (`C:\Program Files\…`, `/usr/lib/GeoLibre Desktop/…`). Ship it lockless and uv resolves, then tries to *write* `uv.lock` there, fails with "Permission denied" and exits 2 — which reaches the user as "Jupyter server exited before it was ready (exit code: 2)" with the cause invisible. So: any edit to that `pyproject.toml`'s dependencies must land with a refreshed lock (`uv lock --project backend/geolibre_server`). CI's "Check the bundled sidecar lockfile is in sync" step (`uv lock --check`) fails if they drift.
- Tauri CSP allowlists tile/style hosts (OpenFreeMap, CARTO) — new external map/tile hosts must be added there.
- Map/tile-host CORS for selected release assets is handled by a dev-server raster proxy.
- For MapLibre control styling fixes, add scoped overrides in `apps/geolibre-desktop/src/index.css`, never edit `node_modules`.
- The Processing **menu** (`ProcessingMenu.tsx`) renders from a checked-in, auto-generated catalog, `apps/geolibre-desktop/src/lib/whitebox-menu-catalog.ts` (do not hand-edit). Whenever `geolibre-wasm` is bumped (in `packages/processing/package.json`) — including Dependabot PRs — run `node scripts/gen-whitebox-menu-catalog.mjs` and commit the result, or new/renamed WASM tools silently miss the menu (the Processing **dialog** lists them dynamically, so the gap only shows in the menu).
- `MAX_VECTOR_PMTILES_ZOOM` (`packages/processing/src/wasm-convert.ts`) mirrors the deepest zoom `vector_to_pmtiles` accepts (18 — past it the tool exits with `validation error: max_zoom must be <= 18`). The cap lives inside the WASM binary and is not exported, so whenever `geolibre-wasm` is bumped — including Dependabot PRs — re-check it. If it drifts, the browser's Vector to PMTiles either refuses a zoom the tiler would now accept, or accepts one it will reject after the user has waited. Note this is **not** the sidecar's cap: freestiler allows 24 (`MAX_PMTILES_ZOOM` in `ConversionDialog.tsx`, mirroring `backend/geolibre_server/geolibre_server/app/conversion.py`), and the dialog validates against whichever engine is about to run. `tests/wasm-convert.test.ts` ("accepts the documented maximum zoom and rejects one deeper") fails in CI if the mirror drifts, so running the frontend suite after a bump is enough to catch it.
- `MAX_VECTOR_BYTES` (`packages/plugins/src/plugins/remote-file-formats.ts`) mirrors `MAX_REMOTE_FILE_BYTES`, an **internal, unexported** constant in `maplibre-gl-vector` (2 GiB — DuckDB-WASM holds remote file sizes in 32 bits). It cannot be imported, so whenever `maplibre-gl-vector` is bumped (in `packages/plugins/package.json`) — including Dependabot PRs — re-check `src/lib/utils/remote.ts` in that package and update the mirror if it moved. If it drifts, the remote-browse panels (Source Cooperative, Hugging Face) silently block GeoParquet the engine could now open, or offer an Add that is certain to fail. Updating the constant is enough: the limit the user is shown is rendered from it, not written into the copy. `remote-file-formats.ts` is the **single** home for this and the other format/reader/size rules those panels share — a per-panel copy would miss this check, so add new browse panels against that module rather than duplicating it (`source-coop-api.ts` re-exports it under its own names for compatibility).
- `MAP_PANEL_SELECTOR` (`apps/geolibre-desktop/src/components/layout/RecordVideoDialog.tsx`) mirrors the **rendered** control class names from `maplibre-gl-components` — `maplibre-gl-html-control`, `maplibre-gl-legend`, `maplibre-gl-colorbar` — so the Record Video "Include map panels" option can rasterize those on-map overlays into the recording. These are the display elements, deliberately **not** the `*-gui-control` authoring editors. The classes are internal and unexported, so whenever `maplibre-gl-components` is bumped (in `packages/plugins/package.json`) — including Dependabot PRs — re-check them against the rendered controls and update the selector if they moved. If a class drifts, the option silently stops burning that panel into the video (or the checkbox never appears) with no build error.
- `GLOBE_CONTROL_TOGGLE_SELECTOR` (`packages/map/src/globe-control-toggle.ts`) mirrors the class names MapLibre's own `GlobeControl` puts on its toggle button — `maplibregl-ctrl-globe` and `maplibregl-ctrl-globe-enabled`, swapped on every projection change. `MapCanvas` persists a projection change from a **click** on that button rather than from the `projectiontransition` event, because style initialization and project reconciliation emit that event too and a stale one overwrites the projection of a project that has just loaded. The classes are internal and unexported, so whenever `maplibre-gl` is bumped (including Dependabot PRs) run the frontend suite — `tests/globe-control-toggle.test.ts` builds a real `GlobeControl` and fails if the mirror stops matching. Without that check a renamed class silently stops persisting the user's projection, with no build error.
- `GeoLibreCogRenderEngine` (`packages/plugins/src/types.ts`) mirrors the `RenderEngine` union `maplibre-gl-raster` exports (`maplibre-gl-raster` | `cog-tiler-wasm` | `titiler`). It is hand-written rather than imported because `types.ts` is the public plugin-API surface and importing there would make that package's types a hard dependency of every external plugin. Unlike the mirrors above this one is checked by the **compiler**, not a test: `CogRenderEngineMirrorIsExact` in `packages/plugins/src/plugins/maplibre-raster.ts` asserts both directions of assignability against the real imported type, so a renamed or dropped engine identifier fails `npm run typecheck`. Nothing extra to do on a `maplibre-gl-raster` bump beyond letting the build run; without it a stale identifier would reach `control.setEngine()` as a string the control no longer recognizes, silently leaving the raster unrendered.
- `propertySpecFor` (`packages/core/src/expressions.ts`) fabricates the **unexported** `StylePropertySpecification` shape that `@maplibre/maplibre-gl-style-spec`'s `createExpression` uses for expected-result-type enforcement (the Expression Builder's filter → boolean / color checks). The cast hides any contract change from the compiler, so whenever `@maplibre/maplibre-gl-style-spec` is bumped (including Dependabot PRs) run the frontend suite — the "enforces an expected result type" test in `tests/expressions.test.ts` fails if the shape stops being honored.
- `DISTANCE_SEGMENTS` / `NON_DISTANCE_NAMES` (`apps/geolibre-desktop/src/lib/whitebox-distance-params.ts`) decide, by parameter *name*, which Whitebox parameters are ground distances and so get the Processing dialog's metric unit picker (GeoLibre#1540). The segments are generic (`tolerance`, `radius`, `length`, `resolution`), so a tool can carry a matching name that is not a length — `corridor_tolerance` is a 0-1 fraction. Those are safe today only because the picker is confined to tools whose every dataset input is a vector layer, and the colliding names happen to sit on imagery/LiDAR tools; that is a coincidence, not a guarantee. So whenever `geolibre-wasm` is bumped (in `packages/processing/package.json`) — including Dependabot PRs — scan the new catalog for a `double` matching the rule whose description reads as a fraction, ratio, angle or weight, and add it to `NON_DISTANCE_NAMES`. If one is missed, that tool's field offers metres and silently converts a dimensionless number as if it were a distance, with no build error.
- UI strings are translatable via **react-i18next**; catalogs live in `apps/geolibre-desktop/src/i18n/locales/*.json` (`en.json` is the source of truth, typed by `i18next.d.ts`). Use `t()` for new user-facing strings; a `?locale`/`?lang` query param sets the embed language. The UI mirrors for right-to-left locales (Arabic), so style new components with Tailwind's logical utilities (`ms-`/`me-`/`ps-`/`pe-`/`text-start`/`border-s`/`start-`…), not the physical `ml-`/`left-` forms. See `docs/i18n.md`.
- Reference docs: `docs/architecture.md`, `docs/project-format.md`, `docs/plugin-api.md`, `docs/python.md`, `docs/mcp.md`, `docs/i18n.md`, `docs/contributing.md`.
