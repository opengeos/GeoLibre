# Settings & Preferences

The **Settings** menu holds the workspace preferences: how the map behaves, which panels are visible, runtime environment variables, project settings, and the entry point to [Manage Plugins](plugins.md).

The Settings dialog is organized into these sections:

| Section | What it covers |
| --- | --- |
| **Map** | Navigation constraints, celestial body, scale units, and coordinate format. See [Map Preferences](#map-preferences). |
| **Layout** | Which panels and toolbar labels are shown. See [Layout](#layout). |
| **Appearance** | Light or dark mode and the accent color applied on top of it. |
| **Interface** | The [UI profile](../ui-profiles.md) — an experience level (Beginner, Intermediate, Advanced, or Custom) that simplifies the menus, data sources, and plugins on offer. Nothing is removed permanently; you can switch levels at any time. |
| **Geocoding** | The address-search provider. See [Data Integrations](data-integrations.md#geocoding). |
| **AI Providers** | Model and credentials for the [AI Assistant](ai-assistant.md). |
| **Environment** | The share token and runtime key-value pairs. See [Environment Variables](#environment-variables). |
| **Updates** | Update checks (desktop only). See [Updates](#updates). |
| **Startup** | Which project the app opens with (desktop only). See [Startup](#startup). |

## Map Preferences

**Settings → Map Preferences** controls how the map can be navigated:

![Settings dialog showing Map Preferences](https://data.geolibre.app/images/geolibre-settings.webp)

| Setting | Description |
| --- | --- |
| **Restrict map bounds** | Limit panning to a bounding box. |
| **Bounds** | The west, south, east, and north limits of that box. |
| **Min zoom / Max zoom** | The allowed zoom range (0 to 24). |
| **Max pitch** | The maximum tilt angle (0 to 85 degrees). |
| **Render world copies** | Show repeated copies of the world when zoomed out. |
| **Celestial body** | The body whose radius drives distance, area, and scale measurements. Pick the one matching your planetary basemap under [Add Data](adding-data.md). |
| **Scale bar units** | Metric (m / km), Imperial (ft / mi), or Nautical (nmi). This also sets the units used by the status bar's **Elev** and **Eye alt** readouts and by the quick-analysis buffer presets. |
| **Coordinate format** | The notation the status bar reports the pointer coordinate in: decimal degrees, DMS, DDM, or UTM. See [the status bar](interface.md#coordinate-format). |

Use **Use Current View** to set the bounds from where the map is now, or **Reset** to restore the defaults. These preferences are saved in the project file.

!!! tip "Capturing bounds on the globe"
    **Use Current View** is most accurate in the Mercator projection. In the Globe projection the map can still drift slightly beyond the captured bounds, and the dialog says so.

## Layout

**Settings → Layout** toggles the chrome around the map:

- **Show toolbar labels**: text labels next to toolbar buttons, or icon-only.
- **Show project info**: the project name and path in the toolbar.
- **Show Layers panel**, **Show Style panel**, **Show Attribute panel**: per-panel visibility.

Panels also auto-hide on small screens for a responsive layout.

## Environment Variables

**Settings → Environment Variables** (the **Environment** tab in the Settings dialog) holds the share token and the runtime key-value pairs that GeoLibre and its plugins read, such as API keys:

- **Share.GeoLibre API token**: the personal API token used by **Project → Share** to upload to `share.geolibre.app`. See [Projects](projects.md#share).
- **Environment variables**: named key-value pairs (for example, API keys for Earth Engine, Street View, and other integrations). You can enable or disable individual variables, and secret values are masked. Variable names must start with a letter or underscore and contain only letters, numbers, and underscores.

!!! tip "Where credentials go"
    Provider credentials for integrations like Earth Engine, Street View, Google Photorealistic 3D Tiles, or other keyed services belong here. See [Data Integrations](data-integrations.md) and [Getting Started](../getting-started.md#optional-imagery-credentials).

!!! tip "Reading AI keys from your system environment (desktop)"
    On the desktop app, the [AI Assistant](ai-assistant.md) also reads its own allowlisted keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and the other provider variables) straight from your operating system's environment variables — so you can keep API keys out of the saved project file entirely. A value entered here always takes precedence over the OS environment. See [AI Assistant → Reading keys from your system environment](ai-assistant.md#reading-keys-from-your-system-environment-desktop) for the full list.

!!! tip "Protomaps basemaps"
    To use the [Protomaps](https://protomaps.com) basemaps in the **New map** dialog, add an environment variable named `VITE_PROTOMAPS_API_KEY` with your own Protomaps API key. The Protomaps options appear in the dialog as soon as the key is enabled — no restart needed. When no key is set, the Protomaps section is hidden. See [Getting Started](../getting-started.md#optional-basemap-credentials) for setting the key at build time for a self-hosted deployment.

## Project name and file

The project name is edited in place on the right of the toolbar, and it is saved into the `.geolibre.json` file. To also see the file path the project was opened from or last saved to, turn on **Show project info** under [Layout](#layout). See [Projects](projects.md) for the rest of the project lifecycle and [Project Format](../project-format.md) for what the file contains.

## Startup

**Settings → Startup** chooses how GeoLibre opens a new session. The installed desktop app also offers project restoration modes:

| Mode | Behavior |
| --- | --- |
| **Open the default workspace** (default) | Start with a new, untitled project. |
| **Reopen the last project** | Open the most recently used *local* project. |
| **Open a specific project** | Always open one chosen project. Use **Choose Project** to pick the file; the mode stays unavailable until you have. |

**Enable 3D globe by default** controls the projection of the new, untitled workspace shown when no project is provided. Turn it off to start that workspace in Mercator. A restored project or project link always uses the projection saved in that project instead.

If the startup project has been moved or deleted, GeoLibre opens the default workspace instead, says so in a banner, and drops the missing file from the recent-projects list.

!!! note "Project restoration is desktop only"
    The browser build includes the empty-workspace projection option, but has no persistent local file to reopen, so the three project modes appear only in the installed desktop app.

Two deliberate limits are worth knowing:

- **Only local projects are reopened.** Opening a share link records it in your recent projects by its `https://` URL, so *Reopen the last project* skips remote entries rather than fetching a third-party host on every launch.
- **A URL always wins.** Launching with a project or `?data=` parameter in the URL skips the startup restore entirely, and so does opening your own project before the restore finishes.

!!! note "Android reopens its own copy"
    Android identifies a project picked from device storage by a temporary reference that stops working once the app's process ends — which is exactly when the startup restore runs. So on Android GeoLibre keeps a copy of the startup project in its own private storage and reopens that copy, refreshing it every time you open or save the project. Two consequences worth knowing: a project edited in another app after you last saved it in GeoLibre reopens as GeoLibre last saw it (open it again from **File → Open** to pick the newer contents back up), and a project deleted from the device still reopens from GeoLibre's copy rather than dropping out of the startup preference, because Android reports a deleted file and an expired reference the same way.

    Saving a project you opened from device storage asks you where to save it, once — Android does not grant write access to a file you only picked to read. If your startup project is that project, the preference follows it to the file that save creates, so it keeps opening the copy you are actually working in.

## Updates

**Settings → Updates** (desktop only) controls the update check: whether GeoLibre checks for a newer version at startup, and which kinds of releases raise a notification. Turn the check off for a fully offline workflow.

## Manage Plugins

**Settings → Manage Plugins** opens the plugin marketplace. See [Plugins & Marketplace](plugins.md).
