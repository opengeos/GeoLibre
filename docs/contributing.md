# Contributing

Thanks for your interest in improving GeoLibre. This guide covers how to set up
a development environment, the project layout, the local quality gate, and the
pull request workflow. Contributions of all sizes are welcome, from fixing a
typo to adding a new processing tool or plugin.

By participating, you agree to keep interactions respectful and constructive.

## Ways to contribute

- **Report a bug or request a feature** by opening an
  [issue](https://github.com/opengeos/GeoLibre/issues). Include steps to
  reproduce, what you expected, and what happened, plus your OS and whether you
  hit it in the web or desktop build.
- **Improve the documentation** under `docs/` (this site).
- **Fix a bug or build a feature** in the app or one of the packages.
- **Write a plugin** using the external plugin API (see
  [Plugins](#plugins-and-extensions) below).

If you plan a large change, open an issue first so we can agree on the approach
before you invest time in a pull request.

## Prerequisites

- **Node.js** 22 or newer
- **Rust** toolchain ([rustup](https://rustup.rs/)) for Tauri desktop builds
- Linux only: `webkit2gtk` and `libayatana-appindicator` (see the
  [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/))
- **Python** 3.10 or newer for [pre-commit](https://pre-commit.com/) (the
  commit hooks below) and, if you work on the backend, the conversion sidecar
  and its tests

## Set up

```bash
git clone https://github.com/opengeos/GeoLibre.git
cd GeoLibre
npm install
```

GeoLibre is an npm workspaces monorepo, so a single `npm install` at the root
wires up every package. Use npm; the repository tracks `package-lock.json`.

## Run it locally

Web build (map in the browser):

```bash
npm run dev
```

Open <http://localhost:5173>.

Desktop build (Tauri, required for filesystem dialogs, local MBTiles, and local
raster reads):

```bash
npm run tauri:dev
```

## Repository layout

```text
apps/geolibre-desktop   # Tauri + React app (shell, composition, Tauri I/O)
packages/core           # Domain types, Zustand store, project format
packages/map            # MapLibre integration and layer sync
packages/ui             # Tailwind + shadcn/ui primitives
packages/plugins        # Plugin API and built-in plugins
packages/processing     # Client-side algorithm registry
workers/viewer          # Cloudflare viewer worker (geolibre-viewer-worker)
backend/geolibre_server # Optional FastAPI conversion sidecar (Python)
docs/                   # This documentation site (MkDocs)
```

See the [Architecture](architecture.md) reference for how these fit together,
and the [Project Format](project-format.md) reference for the saved project
schema.

## Development workflow

1. Create a feature branch off `main`. Never commit directly to `main`.

   ```bash
   git switch -c feat/short-description
   ```

2. Make your change, keeping it focused. Match the style of the surrounding
   code rather than introducing new patterns.
3. Run the [quality checks](#quality-checks) and confirm they pass.
4. Commit with a clear message. The history follows a
   [Conventional Commits](https://www.conventionalcommits.org/) style prefix,
   for example `feat:`, `fix:`, `docs:`, `refactor:`, or `chore:`.
5. Push your branch and open a pull request against `main`. Describe what
   changed and why, and link any related issue.

Pull requests are reviewed before merging. Automated reviewers may leave inline
comments; address them or explain why a suggestion does not apply.

## Quality checks

Run the fast TypeScript unit tests while you work:

```bash
npm run test:frontend
```

Before opening a pull request, run the formatting hooks and the full local
quality gate:

```bash
pre-commit run --all-files
npm run ci
```

`npm run ci` runs the complete gate that mirrors continuous integration:

| Step             | Command                 | Covers                            |
| ---------------- | ----------------------- | --------------------------------- |
| Build            | `npm run build`         | TypeScript compile and Vite build |
| Frontend tests   | `npm run test:frontend` | Fast unit tests under `tests/`    |
| Worker typecheck | `npm run test:worker`   | The viewer worker package         |
| Backend tests    | `npm run test:backend`  | `pytest` for the Python sidecar   |
| Rust check       | `npm run check:rust`    | `cargo check` for the Tauri shell |

You only need the toolchains for the areas you touched. A docs-only or
frontend-only change does not require Rust or Python, though the full `npm run
ci` gate does.

### End-to-end smoke tests

`npm run test:e2e` runs the Playwright smoke suite in `e2e/` against the built
web app (it builds, serves it with `vite preview`, and drives a headless
Chromium). It is a render-path guardrail — it loads a GeoJSON layer, opens the
attribute table, toggles visibility, and runs an accessibility check — not
exhaustive coverage. Install the browser once with `npx playwright install
chromium`. The suite runs as a separate `E2E smoke (Playwright)` job in CI and
uploads its report as an artifact on failure.

### Coding conventions

- Automated formatting runs on every commit via pre-commit hooks.
  [pre-commit.ci](https://pre-commit.ci) runs the same hooks on every PR
  (including forks) and auto-commits a `style: auto-format` fix back to the PR
  branch, so anything the local hooks missed gets fixed automatically. It does
  not run on push to `main`, so auto-formatted commits never bypass review.
  Tooling is split by language:
  - **Python + Jupyter notebooks (`.py`, `.ipynb`)** — [ruff](https://docs.astral.sh/ruff/)
    formats and lints (`ruff.toml`, line length 100, rules `F`/`I`/`W`/`E`).
  - **JS/TS/JSON/CSS/YAML/TOML** — [oxfmt](https://github.com/oxc-project/oxc)
    (npm, NAPI bindings) formats (`.oxfmtrc.json`, 2-space indent, double
    quotes, semicolons, width 100). Note that oxfmt also sorts `package.json`
    keys into its conventional order (e.g. `scripts` before `dependencies`), so
    expect key reordering, not just whitespace changes, when editing those.
    `ignorePatterns` in `.oxfmtrc.json` keeps oxfmt off paths that either belong
    to another tool or churn on every build: Jupyter notebooks and Python source
    (owned by ruff), lockfiles (`package-lock.json`, `pnpm-lock.yaml`,
    `yarn.lock`), generated/vendored bundles (`dist/`, `build/`, `target/`,
    `node_modules/`, minified files, `.d.ts`), Vite-plugin output
    (`*.generated.js`, `*.generated.py`, `cesium/`, `jupyterlite/`), and the
    machine-generated app assets under `apps/geolibre-desktop/public/` (Cesium
    assets, MapLibre sprite atlases, the Whitebox tool-catalog snapshot, which
    grows ~64% under oxfmt). The intentionally malformed
    `e2e/fixtures/malformed.geojson` fixture is also excluded.
  - **ESLint** enforces the React Hooks rules on TS/JS; a `npm run build`
    typecheck runs too.
- All text files are normalized to LF via `.gitattributes` (`* text=auto eol=lf`),
  so line endings are consistent across platforms; `core.autocrlf` is overridden.
- The remaining pre-commit hooks enforce LF line endings (`mixed-line-ending
  --fix=lf`) and basic whitespace (end-of-file and trailing-whitespace fixers).
  You rarely need to format by hand — commit once, let the hooks rewrite, then
  `git add` the fixed files and commit again. Install the hooks after cloning
  with `pre-commit install`.
- Do not edit files in `node_modules`. If a third-party MapLibre control needs
  app-specific styling, add a scoped override in
  `apps/geolibre-desktop/src/index.css` limited to that control's class.
- Keep changes scoped to the package they belong to, and prefer reusing the
  shared primitives in `packages/ui` and helpers in `packages/core`.

## Documentation

The site is built with [Zensical](https://zensical.org), the successor to
MkDocs Material from the same team. It reads the existing `mkdocs.yml`
configuration directly. To preview your changes locally:

```bash
python -m pip install -r requirements-docs.txt
zensical serve
```

Open <http://localhost:8000>. When you add a new page, add it to the `nav` in
`mkdocs.yml`. The site is built with `zensical build --strict` in CI, so broken
links and pages left out of the navigation fail the build. Link to other docs
pages with a relative path (for example `architecture.md`), and link to files
outside `docs/` with a full GitHub URL.

## Plugins and extensions

GeoLibre supports external plugins loaded from a zip, a local directory, or a
hosted manifest URL. To build one, start from the
[GeoLibre plugin template](https://github.com/opengeos/geolibre-plugin-template)
and follow the [Plugin API](plugin-api.md) contract. You do not need to fork
GeoLibre itself to ship a plugin.

## Backend sidecar

The optional [FastAPI sidecar](https://github.com/opengeos/GeoLibre/blob/main/backend/geolibre_server/README.md)
powers the server-side conversion tools. The `conversion` extra installs the
conversion runtime (DuckDB, rio-cogeo, and friends) and the `dev` extra installs
the test runner, so install both when working on it:

```bash
cd backend/geolibre_server
python -m venv .venv && source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -e ".[conversion,dev]"
geolibre-server
```

For a base, conversion-free run (`pip install -e .` plus a plain `uvicorn`
launch), see the [sidecar README](https://github.com/opengeos/GeoLibre/blob/main/backend/geolibre_server/README.md).

Run its tests with `npm run test:backend` from the repository root, or
`python -m pytest` from the backend directory.

## License

GeoLibre is released under the [MIT License](https://github.com/opengeos/GeoLibre/blob/main/LICENSE).
By contributing, you agree that your contributions are licensed under the same
terms.
