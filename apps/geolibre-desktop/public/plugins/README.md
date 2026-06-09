# Bundled plugins (drop-in folder)

Drop a plugin here to **bake it into the GeoLibre build**. It loads
automatically on startup with no Settings entry and no manifest URL — on both
the **web** build and the **desktop** build (the desktop app ships the same
frontend, so one folder serves both).

## Layout

One folder per plugin, named by its plugin id, with a `plugin.json` at its root
(the exact same content a manifest URL would serve):

```text
public/plugins/
  my-plugin/
    plugin.json        # { "id", "name", "version", "entry", "style"? }
    dist/
      index.js         # the "entry" referenced by plugin.json
      style.css        # the optional "style" referenced by plugin.json
```

`entry` and `style` in `plugin.json` are resolved relative to the manifest, so
keep them inside the plugin's own folder.

## How it works

The `bundledPlugins()` Vite plugin
(`apps/geolibre-desktop/vite-plugins/bundled-plugins.ts`) scans this directory
at build and dev-server start and exposes the discovered manifest paths via the
`virtual:bundled-plugins` module. `usePlugins.ts` turns those into origin-absolute
URLs and loads them through the normal external-plugin path (fetch → blob import
→ register). Adding or removing a plugin is just adding or removing a folder —
no code changes.

Discovery happens at **build time**, so a dev server or production build must be
(re)started after adding, updating, or removing a plugin folder.

## Private plugins

The bundles are **git-ignored** (see `.gitignore`) so private plugin code stays
out of this repo's history. Copy the plugin folder in at build/deploy time (for
example, in CI before `npm run build`, or with a plugin repo's own install
script). The discovery code is generic and committed; only the plugin payload
is excluded.
