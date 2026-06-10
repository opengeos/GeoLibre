# Contributing to GeoLibre

Thanks for your interest in improving GeoLibre. The full contributing guide,
including development setup, the repository layout, the quality gate, and the
pull request workflow, lives in the documentation:

**<https://geolibre.app/contributing/>** (source: [`docs/contributing.md`](docs/contributing.md))

## Quick start

```bash
git clone https://github.com/opengeos/GeoLibre.git
cd GeoLibre
npm install
npm run dev          # web build at http://localhost:5173
```

Before opening a pull request:

```bash
pre-commit run --all-files
npm run ci
```

Branch off `main` (never commit to it directly), keep changes focused, follow
[Conventional Commits](https://www.conventionalcommits.org/) for messages, and
open your pull request against `main`. Found a bug or have an idea? Open an
[issue](https://github.com/opengeos/GeoLibre/issues).
