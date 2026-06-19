# UI Profiles & Data Source Filtering

GeoLibre can hide data sources, web services, and plugins to simplify the
interface for beginners or to standardize a deployment across a team. Hiding is
**non-destructive** — nothing is removed, and any item can be re-enabled at any
time. Profile preferences are stored locally in the browser/app and never travel
inside a saved `.geolibre.json` project.

## For users

### Onboarding

On first launch (when no administrator profile is present) GeoLibre asks for an
experience level:

- **Beginner** — only the essential data sources and tools.
- **Intermediate** — common data sources, services, and plugins.
- **Advanced** — everything GeoLibre offers.

Choosing *Skip — show everything* keeps the full interface. The wizard appears
only once; you can revisit the choice later in **Settings → Interface**.

### Settings → Interface

Open **Settings → Interface** to:

- Toggle **Simplify the interface** on or off. When off, everything is visible
  regardless of the lists below.
- Apply an **experience-level** preset (Beginner / Intermediate / Advanced),
  which fills the checklists from each item's complexity.
- Check or uncheck individual **data sources**, **plugins**, whole **menus**
  (Project, Edit, Add Data, Processing, Controls, Plugins, Help), and the items
  within the Project, Edit, Processing, Controls, Settings, and Help menus.
  Editing an item makes the selection *custom* (no preset highlighted).

The **Settings** menu itself, and its Language / Layout / Interface entries, are
always shown so the profile UI can never be hidden away.

## For administrators

A deployment can be pre-configured (and optionally locked) with an
`admin-profile.json` file. When present, it is applied on startup, the onboarding
wizard is skipped, and — if `lock` is set — the Interface settings are read-only.

### File location

- **Web / embed:** serve `admin-profile.json` from the application root (for the
  Docker/nginx build, the served document root). A missing file is ignored.
- **Desktop:** place `admin-profile.json` in the app config directory
  (`read_admin_profile` reads `<app_config_dir>/admin-profile.json`). The desktop
  file takes precedence over a bundled web file.

### File format

```json
{
  "enabled": true,
  "level": "intermediate",
  "lock": true,
  "hiddenDataSources": ["postgres", "video"],
  "hiddenPlugins": ["maplibre-gl-geoagent"]
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `enabled` | boolean | Whether filtering is active. Defaults to `true` for an admin file. |
| `level` | `"beginner" \| "intermediate" \| "advanced"` | Seeds the hidden lists from each item's tier. Optional. |
| `lock` | boolean | When `true`, users cannot change the profile from Settings. Removing the file (or serving one without `lock`) releases the lock on the next launch. |
| `hiddenDataSources` | string[] | Explicit data-source ids to hide. Overrides the preset when present. |
| `hiddenPlugins` | string[] | Explicit plugin ids to hide. Overrides the preset when present. |
| `hiddenMenus` | string[] | Top-level menu ids to hide (`project`, `edit`, `addData`, `processing`, `controls`, `plugins`, `help`). |
| `hiddenMenuItems` | string[] | Menu-item ids to hide (e.g. `processing.raster`, `help.diagnostics`, `controls.minimap`). |

Data-source ids are the catalog ids in
`apps/geolibre-desktop/src/lib/ui-profile.ts` (e.g. `vector`, `xyz`, `mbtiles`,
`postgres`). Plugin ids are the stable ids defined in
`packages/plugins/src/plugins/*` (e.g. `maplibre-gl-geoagent`). Menu and
menu-item ids are the catalog ids in the same `ui-profile.ts`
(`TOP_LEVEL_MENUS`, `MENU_ITEM_CATALOG`).

When a `level` preset is active, external/bundled drop-in plugins (which load
asynchronously after startup) are folded into the hidden set as they appear, so
a beginner profile keeps hiding advanced plugins even when they load late.
