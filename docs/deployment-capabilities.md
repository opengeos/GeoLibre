# Deployment Capabilities

A deployment can pin what the app it serves is allowed to do — a read-only
kiosk, a classroom instance, and everything between that and the full app.

Capabilities are coarse on purpose. Each one names a whole class of action
("may add data at all"), not an individual menu item, so a locked-down
deployment cannot be defeated by one item somebody forgot to list.

!!! warning "Client gates are not a general authorization boundary"
    Withholding a capability removes the affordance: the menu is not rendered,
    the command palette does not list or run the action, the keyboard shortcut
    does nothing, and the embed API refuses the command. These client gates do
    **not** stop someone with browser devtools.

    The Docker container also enforces its final deployment policy at nginx:
    selected `/sidecar/` route families require `processing:run` or `data:add`,
    and `/ai` is disabled unless the final policy enables AI and the approved
    proxy environment is configured. See the exact route table and startup
    rules in [Self-Hosting](self-hosting.md#container-policy-enforcement).
    This enforcement is **container-only**: it does not restrict browser WASM
    engines, desktop processing, or a separately hosted sidecar.

    Keep Basic Auth or a real auth proxy and `GEOLIBRE_CONVERSION_ROOTS` in
    place. Container policy enforcement is not user authentication, and
    capabilities remain the interface half of the story outside those routes.

## Not the same as UI Profiles

[UI Profiles](ui-profiles.md) also hide menus and items, and the two run
independently. The difference is who decides:

| | UI Profiles | Deployment capabilities |
| --- | --- | --- |
| Purpose | Reduce clutter for the audience | Pin what the deployment permits |
| Set by | The user, primary policy `interface`, or legacy admin profile | Primary runtime policy; legacy runtime/build environment fallbacks |
| Reversible in the app | Yes, from Settings → Interface (unless `lock` is set) | No — never surfaced in the UI |
| Granularity | Individual items, data sources, plugins | Whole capabilities |

Where both apply, the capability is checked first. An action the deployment
withheld is never on offer, whatever the profile says.

## The capabilities

| Capability | Grants |
| --- | --- |
| `project:edit` | Authoring the project: New, Open, Open Recent, Import, Project History, Save, Save As, Duplicate, Save as Template, Collaborate, StoryMap; Undo/Redo (the menu items **and** the Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, and Ctrl+Y shortcuts); Export Selection; adding a review comment; the embed API's `loadProject`. |
| `data:add` | Bringing data in: the whole Add Data menu, dragging a file onto the map (browser and desktop), and the embed API's `addLayer` and `addData`. |
| `processing:run` | The whole Processing menu — Whitebox, SQL, Python, the AI assistant, geocoding, Model Builder, conversion/vector/raster tools — and the embed API's `openTool`. |
| `export:data` | Getting data or a rendering back out: Share, Export HTML, Print, Print Layout, Offline Basemap, and the embed API's `exportImage`. |
| `plugins:install` | The Plugins menu, plugin-registered toolbar menus, plugin items in the built-in menus, activating or deactivating a plugin, and the plugin marketplace ("Manage plugins"). |
| `settings:manage` | The Settings dialog and the Style Manager. |

Anything not listed is unprivileged and stays available in every configuration:
panning and zooming, the View and Controls menus, layer visibility and
ordering, identify, the selection tools, and Help.

## Configuring it

### Runtime (recommended)

Set `capabilities` in [`deployment.json`](deployment-policy.md), or use the
Docker runtime override:

```bash
docker run --rm -p 8080:80 \
  -e GEOLIBRE_CAPABILITIES=data:add,export:data \
  ghcr.io/opengeos/geolibre:latest
```

Runtime policy support ships in the published image from v3.3.0 on; see
[Deployment Policy](deployment-policy.md#docker). `none` grants nothing with
the environment variable; JSON uses `"capabilities":[]` for the same empty
grant. Omitted sources grant the default full set.

#### Legacy input — `VITE_GEOLIBRE_CAPABILITIES` still honoured

`VITE_GEOLIBRE_CAPABILITIES` is a legacy build-time fallback:

```bash
VITE_GEOLIBRE_CAPABILITIES="data:add,processing:run,export:data" npm run build
```

On a prebuilt client, runtime deployment policy takes precedence, followed by
`window.__GEOLIBRE_DEPLOYMENT_ENV__`, then this build-time value. The legacy
parser drops unknown tokens; an unrecognized-only nonblank value grants none,
and blank means unset. These rules do not describe JSON policy parsing or
Docker's strict source validation.

```bash
VITE_GEOLIBRE_CAPABILITIES=none npm run build
VITE_GEOLIBRE_CAPABILITIES="export:data" npm run build
VITE_GEOLIBRE_CAPABILITIES="project:edit,data:add,processing:run,export:data" npm run build
```

The examples above are legacy build-time configuration, still honoured; they
do not configure Docker nginx route enforcement.

!!! warning "Client policy loading can fall back"
    Web loading waits at most 3 seconds. A missing or late policy uses the
    runtime environment fallback, then the legacy build environment, then the
    default full grant. Client gates and browser WASM are not access control;
    use Docker nginx policy enforcement or protect APIs independently.

### Runtime examples

A kiosk or exhibit terminal, with no optional capabilities:

```bash
docker run --rm -p 8080:80 -e GEOLIBRE_CAPABILITIES=none ghcr.io/opengeos/geolibre:latest
```

Allow visitors to export an image:

```bash
docker run --rm -p 8080:80 -e GEOLIBRE_CAPABILITIES=export:data ghcr.io/opengeos/geolibre:latest
```

A classroom instance with project authoring, data and processing tools, and
export, but no plugin installs or settings:

```bash
docker run --rm -p 8080:80 \
  -e GEOLIBRE_CAPABILITIES=project:edit,data:add,processing:run,export:data \
  ghcr.io/opengeos/geolibre:latest
```

An embedded map can use an empty grant to refuse commands such as
`loadProject`, `addLayer`, `addData`, `openTool`, and `exportImage`, while
`setView`, `highlightFeature`, and layer-visibility commands remain available.

## Embed API behavior

A denied command rejects rather than silently doing nothing, so the host page
can tell the difference between "refused" and "no effect":

```js
await map.addData("https://example.com/data.geojson");
// Error: Missing data:add capability
```

See [Embedding & Sharing](user-guide/embedding.md) for the full command list.
The embed origin allowlist (`GEOLIBRE_EMBED_ORIGINS`) and capabilities are
independent: the allowlist decides *who* may send commands, capabilities decide
*which* commands exist.

## Related pages

- [Deployment Policy](deployment-policy.md) — primary policy and Docker enforcement
- [Self-Hosting](self-hosting.md#container-policy-enforcement) — exact Docker server-side route guards
- [UI Profiles](ui-profiles.md) — non-destructive interface filtering
- [Embedding & Sharing](user-guide/embedding.md) — embed API and origin allowlist
- [Getting Started](getting-started.md#run-with-docker) — container configuration
