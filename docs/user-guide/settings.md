# Settings & Preferences

The **Settings** menu holds the workspace preferences: how the map behaves, which panels are visible, runtime environment variables, project settings, and the entry point to [Manage Plugins](plugins.md).

## Map Preferences

**Settings → Map Preferences** controls how the map can be navigated:

![Settings dialog showing Map Preferences](https://data.geolibre.app/images/geolibre-settings.webp)

| Setting | Description |
| --- | --- |
| **Restrict bounds** | Limit panning to a bounding box. |
| **Bounds** | The west, south, east, and north limits of that box. |
| **Min zoom / Max zoom** | The allowed zoom range (0 to 24). |
| **Max pitch** | The maximum tilt angle (0 to 85 degrees). |
| **Render world copies** | Show repeated copies of the world when zoomed out. |

You can **apply the current view** to set the bounds from where the map is now, or **reset to defaults**. These preferences are saved in the project file.

## Layout

**Settings → Layout** toggles the chrome around the map:

- **Show toolbar labels**: text labels next to toolbar buttons, or icon-only.
- **Show project info**: the project name and path in the toolbar.
- **Show Layers panel**, **Show Style panel**, **Show Attribute panel**: per-panel visibility.

Panels also auto-hide on small screens for a responsive layout.

## Environment Variables

**Settings → Environment Variables** stores runtime key-value pairs that GeoLibre and its plugins read, such as API keys and tokens. You can enable or disable individual variables, and secret values are masked. Variable names must start with a letter or underscore and contain only letters, numbers, and underscores.

!!! tip "Where credentials go"
    Provider credentials for integrations like Earth Engine, Street View, or other keyed services belong here. See [Data Integrations](data-integrations.md) and [Getting Started](../getting-started.md#optional-imagery-credentials).

## Project Settings

**Settings → Project Settings** holds project-level options:

- **Project name**: the name shown in the toolbar and saved in the project file.
- **Share token**: the personal API token used by **Project → Share** to upload to `share.geolibre.app`. See [Projects](projects.md#share).

## Manage Plugins

**Settings → Manage Plugins** opens the plugin marketplace. See [Plugins & Marketplace](plugins.md).
