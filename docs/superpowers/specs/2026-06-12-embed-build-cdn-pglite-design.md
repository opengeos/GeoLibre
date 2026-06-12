# Embed-build CDN loading for PGlite/PostGIS

Date: 2026-06-12

## Problem

The `geolibre` Python wheel grew from ~24 MB (v1.1.0) to ~47 MB (v1.1.1). The
entire increase comes from the in-browser PostGIS SQL engine added in PR #234
(`feat(sql): add in-browser PostGIS SQL engine via PGlite`). The wheel bundles
the built web app (`geolibre/static/app`), which now includes the lazily-loaded
PGlite assets:

| File | Compressed |
|------|-----------|
| `postgis.tar.gz` (PostGIS extension bundle) | 19.58 MB |
| `pglite.wasm` (PostgreSQL compiled to WASM) | 3.40 MB |
| `pglite.data` | 1.85 MB |
| `initdb.wasm` | 0.14 MB |
| `pglite.js` | 0.14 MB |
| **PGlite subtotal** | **25.1 MB** |

PGlite is already lazy-loaded at runtime (the `SqlWorkspaceDialog` is `lazy()`,
and `pglite-workspace.ts` uses dynamic `import()`), so on the web/desktop it only
downloads when a user opens the SQL workspace. The problem is purely that the
wheel embeds the whole `dist-embed/` tree, so those lazy chunks plus the 19.6 MB
`postgis.tar.gz` ship inside the wheel regardless of whether the feature is used.

## Goals

- Shrink the Jupyter wheel back to ~24 MB.
- Keep the in-browser PostGIS SQL workspace working in Jupyter, loading PGlite
  and the PostGIS extension from a CDN (jsDelivr) on first use.
- Leave the regular web build and the Tauri desktop build unchanged (they keep
  bundling PGlite so they work fully offline / vendored).

## Non-goals

- No change to web or desktop bundling behavior.
- No offline support for the PostGIS SQL feature inside the Jupyter wheel. It is
  an optional feature; needing internet on first use is acceptable. The app
  already loads basemap tiles from the network.
- No change to the SQL-building logic or the dialog UI.

## Constraints verified

- The embedded app is served by the Jupyter Server extension
  (`python/src/geolibre/_extension.py`) and rendered in a **non-sandboxed**
  iframe via `iframe.src` (`python/src/geolibre/_frontend.js`).
- The server sets only `X-Content-Type-Options: nosniff` (for WASM MIME). There
  is **no Content-Security-Policy** anywhere in the embed/web path, so a
  cross-origin script/WASM/data fetch from jsDelivr is not blocked.
- `@electric-sql/pglite` (0.5.2) and `@electric-sql/pglite-postgis` (0.2.2) are
  pure ESM and support CDN loading: they resolve their own `.wasm`, `.data`, and
  `postgis.tar` relative to their module URL, which becomes the jsDelivr path.

## Approach

A build-time flag, set only by the embed build, flips the dynamic `import()` in
`pglite-workspace.ts` from the bundled package to a version-pinned jsDelivr URL.
The bundled branch is dead-code-eliminated in embed mode, so Vite never emits the
pglite chunk, `.wasm`, `.data`, or `postgis.tar`.

### 1. Flag plumbing

`scripts/build-embed.mjs` adds `GEOLIBRE_PGLITE_CDN: "1"` to the build env,
alongside the existing `GEOLIBRE_APP_BASE=./`.

### 2. Vite config (`apps/geolibre-desktop/vite.config.ts`)

Read the env var. Using `createRequire`, read the **installed** versions of
`@electric-sql/pglite` and `@electric-sql/pglite-postgis` from their
`package.json` so the CDN URLs cannot drift from the lockfile. Inject three
`define` constants:

- `__PGLITE_CDN__`: `true` / `false`
- `__PGLITE_CDN_URL__`:
  `"https://cdn.jsdelivr.net/npm/@electric-sql/pglite@<ver>/dist/index.js"`
  (or `null` when not in embed mode)
- `__PGLITE_POSTGIS_CDN_URL__`: the same for `pglite-postgis` (or `null`)

### 3. Runtime branch (`apps/geolibre-desktop/src/lib/pglite-workspace.ts`)

In `getState()`:

```js
let pgliteMod, postgisMod;
if (__PGLITE_CDN__) {
  pgliteMod  = await import(/* @vite-ignore */ __PGLITE_CDN_URL__);
  postgisMod = await import(/* @vite-ignore */ __PGLITE_POSTGIS_CDN_URL__);
} else {
  pgliteMod  = await import("@electric-sql/pglite");
  postgisMod = await import("@electric-sql/pglite-postgis");
}
const { PGlite } = pgliteMod;
const { postgis } = postgisMod;
```

`if (false) { ... }` is reliably tree-shaken by Rollup, so the bundled imports
(and their assets) vanish from the embed build while staying intact everywhere
else. A TypeScript ambient declaration (e.g. in a `*.d.ts`) declares the three
`__PGLITE_*__` globals so the source typechecks.

The CDN error path reuses the existing `getState()` behavior: on failure it
resets `statePromise` so the load is retryable, and the dialog surfaces the
error. The thrown message is adjusted to mention that the PostGIS engine is
fetched from a CDN and needs network access, so a failure is diagnosable.

### 4. Build guard

`scripts/build-embed.mjs` already guards against absolute asset paths in
`index.html`. Add a second guard: after the build, fail if any `postgis.tar*`
file exists under `dist-embed/assets/`, so the wheel cannot silently regrow if
the dead-code-elimination ever stops working.

## Verification

1. `npm run build:embed`, then assert `dist-embed/assets/` contains **no**
   `postgis.tar*`, `pglite*.wasm`, `pglite*.data`, `initdb*.wasm`, or pglite JS
   chunk.
2. Confirm the staged `python/src/geolibre/static/app` tree shrinks by ~25 MB and
   a freshly built wheel is back to ~24 MB.
3. Run the regular `npm run build` and confirm it **still** bundles the PGlite
   assets (web/desktop unchanged).
4. `npm run test:frontend` (the `pglite-sql.ts` unit tests are unaffected, but
   confirm nothing regressed) and `npm run typecheck`.
5. Manual: build the wheel, open the embedded app in Jupyter, open the SQL
   workspace, pick the PostGIS engine, and confirm it loads from jsDelivr and
   runs a query.

## Risks

- **Tree-shaking the bundled import in embed mode** is the load-bearing
  assumption. Verified empirically in step 1 of Verification before declaring
  done; the build guard (step 4 of Approach) is the backstop.
- **CDN availability at runtime.** The Jupyter PostGIS SQL feature now needs
  internet on first use. jsDelivr CORS is permissive and no CSP blocks it.
  Accepted per the chosen direction.
- **Version drift.** CDN URLs are pinned from the installed package versions at
  build time, so they cannot diverge from the lockfile.
