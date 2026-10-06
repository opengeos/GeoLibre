# Settings & Preferences

The **Settings** menu holds the workspace preferences: how the map behaves, which panels are visible, the interface language and appearance, geocoding and AI providers, runtime environment variables, and the entry point to [Manage Plugins](plugins.md).

![The Settings menu](https://assets.geolibre.app/images/geolibre-settings-menu.webp)

The Settings dialog is organized into these sections:

| Section | What it covers |
| --- | --- |
| **Language** | The interface language and optional Whitebox language packs. See [Language](#language). |
| **Map** | Navigation constraints, celestial body, scale units, and coordinate format. See [Map Preferences](#map-preferences). |
| **Layout** | Which panels and toolbar labels are shown. See [Layout](#layout). |
| **Appearance** | Light or dark mode and the accent color applied on top of it. See [Appearance](#appearance). |
| **Interface** | The [UI profile](../ui-profiles.md) — an experience level (Beginner, Intermediate, Advanced, or Custom) that simplifies the menus, data sources, and plugins on offer. Nothing is removed permanently; you can switch levels at any time. See [Interface](#interface). |
| **Geocoding** | The address-search provider. See [Geocoding](#geocoding). |
| **AI Providers** | Model and credentials for the [AI Assistant](ai-assistant.md). See [AI Providers](#ai-providers). |
| **Environment** | The share token and runtime key-value pairs. See [Environment Variables](#environment-variables). |
| **Cloud Storage** | S3 connections for private buckets, and the S3 Browser's default location. See [Cloud Storage](#cloud-storage). |
| **Updates** | Update checks (desktop only). See [Updates](#updates). |
| **Startup** | The untitled workspace's projection and view, and (desktop only) which project the app opens with. See [Startup](#startup). |
| **Style Manager** | Your saved symbology presets, reachable here and from a layer's **Layer actions → Styles → Saved styles**. See [Styling Layers](styling.md). |

## Language

**Settings → Language** sets the **Interface language**. Each option is shown in its own script, with the English name alongside. Right-to-left languages mirror the whole layout. See [Internationalization](../i18n.md) for the supported languages.

The same section manages optional **Whitebox language packs**, which translate Whitebox tool names, parameters, and help text without making every installation larger. Choose **Download pack** to fetch the official pack for the selected language, or **Import file** to install a pack file. **Remove pack** returns the Whitebox metadata to English. Packs are stored only on the current device. Downloading one sends the locale code, but no project data, to the pack host. Builds that disable downloads offer only **Import file**.

## Map Preferences

**Settings → Map Preferences** controls how the map can be navigated:

![The Settings dialog, open on Map Preferences](https://assets.geolibre.app/images/geolibre-settings.webp)

| Setting | Description |
| --- | --- |
| **Restrict map bounds** | Limit panning to a bounding box. |
| **Bounds** | The west, south, east, and north limits of that box. |
| **Min zoom / Max zoom** | The allowed zoom range (0 to 24). |
| **Max pitch** | The maximum tilt angle (0 to 85 degrees). |
| **Render world copies** | Show repeated copies of the world when zoomed out. |
| **Celestial body** | The body whose radius drives distance, area, and scale measurements. Pick the one matching your planetary basemap under [Add Data](adding-data.md). |
| **Scale bar units** | Metric (m / km), Imperial (ft / mi), or Nautical (nmi). This also sets the units used by the status bar's **Elev** and **Eye alt** readouts and by the quick-analysis buffer presets. |
| **Coordinate format** | The notation the status bar reports the pointer coordinate in: decimal degrees, DMS, DDM, UTM, MGRS, USNG, or x/y in a projected CRS. Choosing the projected format shows an **EPSG** field for the CRS code. See [the status bar](interface.md#coordinate-format). |

Use **Use Current View** to set the bounds from where the map is now, or **Reset** to restore the defaults. These preferences are saved in the project file.

!!! tip "Capturing bounds on the globe"
    **Use Current View** is most accurate in the Mercator projection. In the Globe projection the map can still drift slightly beyond the captured bounds, and the dialog says so.

## Layout

**Settings → Layout Settings** toggles the chrome around the map:

- **Show toolbar labels**: text labels next to toolbar buttons, or icon-only.
- **Show project info**: the project name and path in the toolbar.
- **Show Layers panel**, **Show Style panel**, **Show Browser panel**, **Show Comments panel**: per-panel visibility.

Panels also auto-hide on small screens for a responsive layout.

## Appearance

**Settings → Appearance** picks the **Mode** (Light or Dark) and an **Accent color** applied on top of it: Blue, Violet, Emerald, Rose, Amber, or **Custom**, which takes any color from a picker or a hex code.

## Interface

**Settings → Interface** chooses an **Experience level** that simplifies the interface: **Beginner**, **Intermediate**, and **Advanced** apply a curated layout at once. Below the levels you can switch individual **Data sources**, **Plugins**, and **Menus** on or off. Editing any of them switches the level to **Custom**. Nothing is removed permanently, and **Reset** restores the defaults. When an administrator manages the profile, this section is read-only. See [UI Profiles](../ui-profiles.md#settings-interface).

## Geocoding

**Settings → Geocoding** chooses the **Provider** used by Geocode Addresses, address import, and Reverse Geocode. Nominatim is the default and needs no key. For providers that need one, enter an **API key**. You can also override the **Forward endpoint** and **Reverse endpoint**, for example to point at a self-hosted instance, and give Nominatim a **Contact email**. The section notes where keys are stored: in the system keychain when it is available, otherwise in the project file. Keys are sent as query parameters, so they appear in request URLs. See [Data Integrations → Geocoding](data-integrations.md#geocoding) for the provider list.

## AI Providers

**Settings → AI Providers** configures the credentials for the [AI Assistant](ai-assistant.md). Each configuration is a named **profile**, such as *Work Gemini* or *Local Ollama*. Choose **Add profile**, pick a provider, fill in the fields it asks for, then **Save profile**. Mark one profile **Set as default** to use it when the assistant opens; one configured profile is enough to start chatting. Credentials are saved on the current device, never in the project file. When a system keychain is available, the secret fields go there. On the desktop app, a blank key field falls back to the matching operating-system environment variable. See [AI Assistant → Setup](ai-assistant.md#setup-choose-an-ai-provider).

## Environment Variables

**Settings → Environment Variables** (the **Environment** tab in the Settings dialog) holds the share account connection and the runtime key-value pairs that GeoLibre and its plugins read, such as API keys:

- **Share.GeoLibre account**: sign in to `share.geolibre.app` (a popup on the web, your system browser on the desktop app), or sign out. Used by **Project → Share** and the Project Gallery. See [Projects](projects.md#share).
- **Share.GeoLibre API token**: a personal API token for **Project → Share**, the fallback when sign-in is not available (for example on mobile or in a notebook embed). See [Projects](projects.md#share).
- **Environment variables**: named key-value pairs (for example, API keys for Earth Engine, Street View, and other integrations). You can enable or disable individual variables, and secret values are masked. Variable names must start with a letter or underscore and contain only letters, numbers, and underscores.

!!! tip "Where credentials go"
    Provider credentials for integrations like Earth Engine, Street View, Google Photorealistic 3D Tiles, or other keyed services belong here. See [Data Integrations](data-integrations.md) and [Getting Started](../getting-started.md#optional-imagery-credentials).

!!! tip "Reading AI keys from your system environment (desktop)"
    On the desktop app, the [AI Assistant](ai-assistant.md) also reads its own allowlisted keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and the other provider variables) straight from your operating system's environment variables — so you can keep API keys out of the saved project file entirely. A value entered here always takes precedence over the OS environment. See [AI Assistant → Reading keys from your system environment](ai-assistant.md#reading-keys-from-your-system-environment-desktop) for the full list.

!!! tip "Protomaps basemaps"
    To use the [Protomaps](https://protomaps.com) basemaps in the **New project** dialog, add an environment variable named `VITE_PROTOMAPS_API_KEY` with your own Protomaps API key. The Protomaps options appear in the dialog as soon as the key is enabled — no restart needed. When no key is set, the Protomaps section is hidden. See [Getting Started](../getting-started.md#optional-basemap-credentials) for setting the key at build time for a self-hosted deployment.

## Cloud Storage

**Settings → Cloud Storage** (also in the **Settings** menu) holds the S3 connections that read private Amazon S3 and S3-compatible buckets (access keys, AWS profiles including SSO, environment variables, and IAM roles), and the S3 Browser's default location. See [Cloud Storage](cloud-storage.md).

## Project name and file

The project name is edited in place on the right of the toolbar, and it is saved into the `.geolibre.json` file. To also see the file path the project was opened from or last saved to, turn on **Show project info** under [Layout](#layout). See [Projects](projects.md) for the rest of the project lifecycle and [Project Format](../project-format.md) for what the file contains.

## Startup

**Settings → Startup Settings** chooses how GeoLibre opens a new session. The installed desktop app also offers project restoration modes:

| Mode | Behavior |
| --- | --- |
| **Open the default workspace** (default) | Start with a new, untitled project. |
| **Reopen the last project** | Open the most recently used *local* project. |
| **Open a specific project** | Always open one chosen project. Use **Choose Project** to pick the file; the mode stays unavailable until you have. |

**Enable 3D globe by default** controls the projection of the new, untitled workspace shown when no project is provided. Turn it off to start that workspace in Mercator. **Default map view** sets the center longitude, center latitude, and zoom level for the same workspace. Choose **Use Current View** to copy the center and zoom from the map canvas. A restored project or project link always uses the projection and camera saved in that project instead.

**Open the S3 Browser at startup** shows the [S3 Browser](cloud-storage.md) panel each time GeoLibre starts; it stays open when you open a project. **Default layer styles** takes a layer styles file (**Project → Export → Export Layer Styles**): each layer you add whose name matches a style in it is styled automatically, while layers in opened projects keep their saved styles. GeoLibre keeps a copy of the file, so choose it again after editing it.

If the startup project has been moved or deleted, GeoLibre opens the default workspace instead, says so in a banner, and drops the missing file from the recent-projects list.

!!! note "Project restoration is desktop only"
    The browser build includes the empty-workspace projection option, but has no persistent local file to reopen, so the three project modes appear only in the installed desktop app.

Two deliberate limits are worth knowing:

- **Only local projects are reopened.** Opening a share link records it in your recent projects by its `https://` URL, so *Reopen the last project* skips remote entries rather than fetching a third-party host on every launch.
- **A URL always wins.** Launching with a project or `?data=` parameter in the URL skips the startup restore entirely, and so does opening your own project before the restore finishes.

!!! note "Android reopens its own copy"
    Android identifies a project picked from device storage by a temporary reference that stops working once the app's process ends — which is exactly when the startup restore runs. So on Android GeoLibre keeps a copy of the startup project in its own private storage and reopens that copy, refreshing it every time you open or save the project. Two consequences worth knowing: a project edited in another app after you last saved it in GeoLibre reopens as GeoLibre last saw it (open it again from **Project → Open From → File...** to pick the newer contents back up), and a project deleted from the device still reopens from GeoLibre's copy rather than dropping out of the startup preference, because Android reports a deleted file and an expired reference the same way.

    Saving a project you opened from device storage asks you where to save it, once — Android does not grant write access to a file you only picked to read. If your startup project is that project, the preference follows it to the file that save creates, so it keeps opening the copy you are actually working in.

## Updates

**Settings → Update Settings** (desktop only) controls the update check: whether GeoLibre checks for a newer version at startup, and which kinds of releases raise a notification. Turn the check off for a fully offline workflow.

## Style Manager

**Settings → Style Manager** opens your personal library of symbology presets. Save the style you have built on a layer, then apply it to any other layer in any project. The same library is reachable from a layer's **Layer actions → Styles → Saved styles (Style Manager)…**. See [Styling Layers](styling.md).

## Manage Plugins

**Settings → Manage Plugins** opens the plugin marketplace. See [Plugins & Marketplace](plugins.md).
