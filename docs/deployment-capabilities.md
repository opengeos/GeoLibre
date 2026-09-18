# Deployment Capabilities

A deployment can pin what the app it serves is allowed to do — a read-only
kiosk, a classroom instance, and everything between that and the full app.

Capabilities are coarse on purpose. Each one names a whole class of action
("may add data at all"), not an individual menu item, so a locked-down
deployment cannot be defeated by one item somebody forgot to list.

!!! warning "This is a client-side gate, not an authorization boundary"
    Withholding a capability removes the affordance: the menu is not rendered,
    the command palette does not list or run the action, the keyboard shortcut
    does nothing, and the embed API refuses the command. It does **not** stop
    someone with browser devtools, and it does not restrict the server.

    The sidecar (`/sidecar`) and AI proxy (`/ai`) endpoints answer the same
    requests whatever capabilities are configured. For a deployment that must
    hold up against its own users, keep the server-side protections in
    [Self-Hosting](self-hosting.md) — Basic Auth or a real auth proxy,
    `GEOLIBRE_CONVERSION_ROOTS`, `GEOLIBRE_DISABLE_SIDECAR` — and treat
    capabilities as the interface half of the story.

## Not the same as UI Profiles

[UI Profiles](ui-profiles.md) also hide menus and items, and the two run
independently. The difference is who decides:

| | UI Profiles | Deployment capabilities |
| --- | --- | --- |
| Purpose | Reduce clutter for the audience | Pin what the deployment permits |
| Set by | The user, or an `admin-profile.json` | The build/deployment configuration |
| Reversible in the app | Yes, from Settings → Interface (unless `lock` is set) | No — never surfaced in the UI |
| Granularity | Individual items, data sources, plugins | Whole capabilities |

Where both apply, the capability is checked first. An action the deployment
withheld is never on offer, whatever the profile says.

## The capabilities

| Capability | Grants |
| --- | --- |
| `project:edit` | Authoring the project: New, Open, Open Recent, Import, Project History, Save, Save As, Duplicate, Save as Template, Collaborate, StoryMap; Undo/Redo (the menu items **and** the Ctrl/Cmd+Z and Ctrl+Y shortcuts); Export Selection; adding a review comment; the embed API's `loadProject`. |
| `data:add` | Bringing data in: the whole Add Data menu, dragging a file onto the map (browser and desktop), and the embed API's `addLayer` and `addData`. |
| `processing:run` | The whole Processing menu — Whitebox, SQL, Python, the AI assistant, geocoding, Model Builder, conversion/vector/raster tools — and the embed API's `openTool`. |
| `export:data` | Getting data or a rendering back out: Share, Export HTML, Print, Print Layout, Offline Basemap, and the embed API's `exportImage`. |
| `plugins:install` | The Plugins menu, plugin-registered toolbar menus, activating or deactivating a plugin, and the plugin marketplace ("Manage plugins"). |
| `settings:manage` | The Settings dialog and the Style Manager. |

Anything not listed is unprivileged and stays available in every configuration:
panning and zooming, the View and Controls menus, layer visibility and
ordering, identify, the selection tools, and Help.

## Configuring it

Set `VITE_GEOLIBRE_CAPABILITIES` to a comma-separated list of the capabilities
you want to grant, at build time:

```bash
VITE_GEOLIBRE_CAPABILITIES="data:add,processing:run,export:data" npm run build
```

For the Docker image, pass it as a build argument:

```bash
docker build \
  --build-arg VITE_GEOLIBRE_CAPABILITIES="data:add,processing:run,export:data" \
  -t geolibre-classroom .
```

!!! note "Build time only, for now"
    Unlike `GEOLIBRE_SHARE_URL`, `GEOLIBRE_EMBED_ORIGINS`, and the other
    deployment settings, this cannot yet be set with `-e` on a **prebuilt**
    image — `docker/entrypoint.sh` does not publish it into the runtime
    configuration, so it has to be baked in. Configuring a published image with
    `-e GEOLIBRE_MODE=kiosk`, and having nginx refuse the corresponding
    requests, is tracked in
    [#1673](https://github.com/opengeos/GeoLibre/issues/1673).

### Defaults and parsing

- **Unset (the default) grants everything.** An existing deployment that
  configures nothing behaves exactly as it did before.
- **Setting it at all is a restriction.** Only the capabilities you name are
  granted; everything else is withheld.
- **Unknown names are dropped, not granted.** A build that does not recognize a
  capability treats it as ungranted rather than failing to start, so a config
  written for a newer version does not quietly widen an older one.
- **The parse fails closed.** A value that names nothing recognizable grants
  nothing at all, rather than falling back to the full set.
- **A blank value reads as unset**, and so grants everything. An empty string
  is what `-e VAR=` produces, and unset has to keep meaning "full". To grant
  nothing, write `none` (see below) rather than leaving the value empty.

## Examples

A kiosk or exhibit terminal — open the configured project, pan, zoom, toggle
layers, identify, and nothing else. `none` is the reserved spelling for an
empty grant:

```bash
VITE_GEOLIBRE_CAPABILITIES=none npm run build
```

The same kiosk, but visitors may save a picture of what they are looking at:

```bash
VITE_GEOLIBRE_CAPABILITIES="export:data" npm run build
```

A classroom instance — the full map and processing tools, but no plugin
installs and no settings:

```bash
VITE_GEOLIBRE_CAPABILITIES="project:edit,data:add,processing:run,export:data" \
  npm run build
```

An embedded map on a public site that should not become a general-purpose
data-fetching proxy for the page framing it. With `none`, the embed API refuses
`loadProject`, `addLayer`, `addData`, `openTool`, and `exportImage`, while
`setView`, `highlight`, and the layer-visibility commands keep working — so the
host page can still drive the map without being able to load anything into it.

## Embed API behavior

A denied command rejects rather than silently doing nothing, so the host page
can tell the difference between "refused" and "no effect":

```js
await map.addData({ url: "https://example.com/data.geojson" });
// Error: Missing data:add capability
```

See [Embedding & Sharing](user-guide/embedding.md) for the full command list.
The embed origin allowlist (`GEOLIBRE_EMBED_ORIGINS`) and capabilities are
independent: the allowlist decides *who* may send commands, capabilities decide
*which* commands exist.

## Related pages

- [Self-Hosting](self-hosting.md) — the server-side protections this does not replace
- [UI Profiles](ui-profiles.md) — non-destructive interface filtering
- [Embedding & Sharing](user-guide/embedding.md) — the embed API and its origin allowlist
- [Getting Started](getting-started.md#run-with-docker) — the full container configuration list
