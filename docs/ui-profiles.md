# UI Profiles & Data Source Filtering

GeoLibre can hide data sources, web services, and plugins to simplify the
interface for beginners or to standardize a deployment across a team. Hiding is
**non-destructive** — nothing is removed, and any item can be re-enabled at any
time. Profile preferences are stored locally in the browser/app and never travel
inside a saved `.geolibre.json` project.

!!! tip "Looking to lock a deployment down?"
    Profiles declutter; the user can undo them. To pin what a deployment is
    *permitted* to do — a kiosk, a classroom instance — see
    [Deployment Capabilities](deployment-capabilities.md), which is never
    surfaced in the UI. The two are independent and can be combined.

## For users

### Onboarding

By default GeoLibre starts on the **Advanced** interface — everything visible —
and does not show a first-launch welcome dialog. Choose a simpler experience
level at any time from **Settings → Interface** (see below):

- **Beginner** — only the essential data sources and tools.
- **Intermediate** — common data sources, services, and plugins.
- **Advanced** — everything GeoLibre offers (the default).

An administrator can pre-configure the interface in the primary
[`deployment.json` policy](deployment-policy.md), or use the legacy
`admin-profile.json` fallback described below.

### Settings → Interface

The interface is controlled by a single four-state selector:

- **Beginner** / **Intermediate** / **Advanced** are developer-curated presets.
  Selecting one applies its layout immediately. **Advanced** reveals everything,
  so it is the full, unrestricted interface.
- **Custom** activates automatically the moment you hand-edit any item below; it
  is a status, not a button you click.

Open **Settings → Interface** to:

- Pick an **experience level**, which fills the checklists from each item's
  complexity and takes effect at once.
- Check or uncheck individual **data sources**, **plugins**, whole **menus**
  (Project, Edit, View, Add Data, Processing, Controls, Plugins, Help), and the
  items within the Project, Edit, View, Processing, Controls, Settings, and Help
  menus.
  Editing any item switches the selector to **Custom**.

The **Settings** menu itself, and its Language / Layout / Interface entries, are
always shown so the profile UI can never be hidden away.

## For administrators

Use the `interface` section in the primary deployment policy. For example:

```json
{
  "version": 1,
  "interface": {
    "enabled": true,
    "level": "intermediate",
    "lock": true,
    "hiddenDataSources": ["postgres", "video"],
    "hiddenPlugins": ["maplibre-gl-geoagent"]
  }
}
```

The `interface` field table below describes this section. Provision it at
[`<base>/deployment.json` for web/embed](deployment-policy.md#loading),
the [desktop config directory](deployment-policy.md#desktop), or as a
[Docker source policy](deployment-policy.md#docker).

### Legacy: `admin-profile.json` — still honoured

The legacy file remains a fallback when the selected deployment policy has no
non-empty, valid `interface` section. Its unwrapped format is:

```json
{
  "enabled": true,
  "level": "intermediate",
  "lock": true,
  "hiddenDataSources": ["postgres", "video"],
  "hiddenPlugins": ["maplibre-gl-geoagent"]
}
```

For web/embed, serve it from the application root. On desktop, the original
file remains at `<app_config_dir>/admin-profile.json`; see the standard
[Tauri config paths](deployment-policy.md#desktop). A present desktop file is
authoritative even if malformed, and does not fall back to the bundled copy.
Only an absent file or a failed read/command selects the web copy.

### Interface fields

The primary `interface` object and the legacy `admin-profile.json` file share
these profile fields; the legacy file stores them at top level.

| Field | Type | Meaning |
| --- | --- | --- |
| `enabled` | boolean | Whether filtering is active. Defaults to `true`. |
| `level` | `"beginner" \| "intermediate" \| "advanced"` | Seeds the hidden lists from each item's tier. Optional. |
| `lock` | boolean | When `true`, users cannot change the profile from Settings. To release the lock on the next launch, remove or clear `interface.lock` in the selected deployment policy, or the top-level `lock` in the legacy profile. |
| `hiddenDataSources` | string[] | Explicit data-source ids to hide. Overrides the preset when present. |
| `hiddenPlugins` | string[] | Explicit plugin ids to hide. Overrides the preset when present. |
| `hiddenMenus` | string[] | Top-level menu ids to hide (`project`, `edit`, `view`, `addData`, `processing`, `controls`, `plugins`, `help`). |
| `hiddenMenuItems` | string[] | Menu-item ids to hide (e.g. `processing.raster`, `help.diagnostics`, `controls.minimap`). |

Data-source ids are the catalog ids in
`apps/geolibre-desktop/src/lib/ui-profile.ts` (e.g. `vector`, `xyz`, `mbtiles`,
`postgres`). Plugin ids are the stable ids defined in
`packages/plugins/src/plugins/*` and `packages/plugins/src/plugin-ids.ts`
(e.g. `maplibre-gl-geoagent`). Menu and
menu-item ids are the catalog ids in the same `ui-profile.ts`
(`TOP_LEVEL_MENUS`, `MENU_ITEM_CATALOG`).

When a `level` preset is active, external/bundled drop-in plugins (which load
asynchronously after startup) are folded into the hidden set as they appear, so
a beginner profile keeps hiding advanced plugins even when they load late.
