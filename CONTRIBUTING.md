# Contributing to GeoLibre

Thanks for your interest in improving GeoLibre. The full contributing guide,
including development setup, the repository layout, the quality gate, and the
pull request workflow, lives in the documentation:

**<https://geolibre.app/contributing/>** (source: [`docs/contributing.md`](docs/contributing.md))

## Quick Start

Fork the repository, then clone your fork. Replace `YOUR_GITHUB_USERNAME` with
your GitHub username:

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/GeoLibre.git
cd GeoLibre
npm install
npm run dev          # web build at http://localhost:5173
```

Before opening a pull request:

```bash
pre-commit run --files path/to/changed.ts path/to/other.tsx   # list each file you changed
npm run ci:web   # frontend-only changes: lint, i18n check, type check, unit tests
npm run ci       # the full gate CI runs (also needs Rust and Python)
```

Prefer `--files` over `--all-files`, which re-checks the whole repository. See
[Quality checks](docs/contributing.md#quality-checks) for what each gate runs.

Branch off `main` (never commit to it directly), keep changes focused, follow
[Conventional Commits](https://www.conventionalcommits.org/) for messages, and
open your pull request against `main`. Found a bug or have an idea? Open an
[issue](https://github.com/opengeos/GeoLibre/issues).
