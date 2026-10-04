# Deployment Policy

`deployment.json` is a single, versioned file that describes the client-facing
settings of a GeoLibre deployment: which capabilities users have, which
interface elements are visible, which plugins may load, the curated service
library, sharing endpoints, and branding.

## Loading

The web and Jupyter builds fetch `deployment.json` from the app's base URL
(`<base>/deployment.json`) before the first render. Desktop reads its config-dir
file first (see [Desktop](#desktop)); only an absent file or a failed read falls
back to that web URL. The selected policy is resolved before the first render.
No policy applies when the selected file is absent (404 or an HTML fallback
page), not JSON, or of an unknown `version`. An unreachable web file or a fetch
that takes more than 3 seconds also yields no policy. In those cases the app
uses the next client configuration source.

Every build ships a `deployment.json` stub containing `null`, which means no
policy, so static hosts answer the startup fetch instead of logging a 404. To
apply a policy on a static host, replace that file in the published output; on
Docker the entrypoint overwrites it on every boot. On desktop the stub is the
bundled web fallback, so a config-dir file still takes precedence.

The recommended deployment input is a versioned `deployment.json`. On Docker,
the entrypoint validates the mounted source, applies nonblank environment
overrides field by field, and writes the generated public policy on every boot
(see [Docker](#docker)). The client then resolves settings in this order:
final policy, `window.__GEOLIBRE_DEPLOYMENT_ENV__`, then build environment.

**Availability:** Runtime policy delivery and Docker enforcement live on
`main`. Published Docker images and desktop releases may predate them. If a
Docker image does not honour `deployment.json`, build the image from `main`.
For desktop, use a build that includes this support.

The previous `admin-profile.json` and `VITE_GEOLIBRE_CAPABILITIES` inputs are
**legacy, still honoured**. They remain fallbacks where the primary policy does
not specify a usable section; this documentation does not remove them.

What each section does today:

- `capabilities` restricts the app; `[]` grants none, and omitting it leaves
  the legacy `VITE_GEOLIBRE_CAPABILITIES` (or the default full grant) in force.
- A non-empty `interface` object replaces the legacy `admin-profile.json`
  whole; fields are not merged. An omitted, empty (`{}`), or invalid interface
  leaves the legacy profile eligible.
- `plugins.registryUrl` sets the plugin registry. `allowed`, `blocked` and
  `sideload` gate external plugin loads and installs; `defaultActive` seeds
  activation in fresh projects.
- `services`, `sharing`, `geolens` and `branding.appName` override the
  matching `GEOLIBRE_*` deployment settings. `sharing.embedOrigins: []` turns
  the embed API off.
- `branding.welcome: false` suppresses the first-launch wizard.
- `ai.enabled: true` points the assistant at the same-origin `/ai` proxy;
  `false` removes any operator-configured AI proxy (a provider a user enters in
  Settings is unaffected). `ai.model` picks the proxy's model.

The client parser is lenient and section-based. Invalid sections, including
capabilities with unknown names, are dropped with a warning; other valid
sections survive. Capabilities then fall back to runtime or build environment,
or the default full grant. Docker source validation is strict and fails boot
before overrides can repair an invalid input file.

```json
{"version":1,"capabilities":["data:add","export:data"],"interface":{"enabled":true,"level":"intermediate","lock":true}}
```

For capability details and Docker route enforcement, see
[Deployment Capabilities](deployment-capabilities.md) and
[Self-Hosting: container policy enforcement](self-hosting.md#container-policy-enforcement).

## Example

```json
{
  "version": 1,
  "capabilities": ["project:edit", "data:add", "processing:run", "export:data", "plugins:install", "settings:manage"],
  "interface": {
    "enabled": true,
    "level": "intermediate",
    "lock": true,
    "hiddenDataSources": ["arcgis"],
    "hiddenPlugins": ["plugin-a"],
    "hiddenMenus": ["help"],
    "hiddenMenuItems": ["file.print"]
  },
  "plugins": {
    "registryUrl": "https://plugins.example.com/registry.json",
    "allowed": ["acme-tools"],
    "blocked": ["bad-plugin"],
    "sideload": false,
    "defaultActive": ["acme-tools"]
  },
  "services": {
    "builtins": true,
    "catalog": [
      {
        "id": "city-wms",
        "name": "City WMS",
        "kind": "wms",
        "category": "Municipal",
        "fields": { "url": "https://maps.example.com/wms", "version": "1.3.0", "opacity": 0.8, "transparent": true }
      }
    ]
  },
  "sharing": {
    "shareUrl": "https://projects.example.com",
    "collabUrl": "wss://relay.example.com",
    "embedOrigins": ["https://portal.example.com"]
  },
  "geolens": { "url": "same-origin" },
  "ai": { "enabled": true, "model": "gpt-5-mini" },
  "branding": { "appName": "Acme Maps", "welcome": false }
}
```

Point your editor at the schema for completion and validation by adding
`"$schema": "https://raw.githubusercontent.com/opengeos/GeoLibre/main/schema/deployment.schema.json"`.
GeoLibre ignores `$schema`.

## Field reference

Every section and every field is optional except `version`. An absent section
means "not specified": the next source in the precedence chain applies.

### Top level

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | `1` | Policy format version. Documents with any other version are ignored. |

### `capabilities`

An array of the capability names from
[Deployment Capabilities](deployment-capabilities.md): `project:edit`,
`data:add`, `processing:run`, `export:data`, `plugins:install`,
`settings:manage`. Omit it to grant all capabilities; `[]` grants none.

### `interface`

| Field | Type | Meaning |
| --- | --- | --- |
| `enabled` | boolean | Whether UI profile filtering is active (default true). |
| `level` | `beginner` \| `intermediate` \| `advanced` | Experience-level preset that seeds the hidden lists. |
| `lock` | boolean | Prevent users changing the profile in Settings. |
| `hiddenDataSources`, `hiddenPlugins`, `hiddenMenus`, `hiddenMenuItems` | string[] | Explicit hidden ids, overriding the preset. |

### `plugins`

| Field | Type | Meaning |
| --- | --- | --- |
| `registryUrl` | string | Plugin marketplace registry URL, absolute or relative to the app. |
| `allowed` | string[] | External plugin ids allowed to load. Omit for any; `[]` for none. |
| `blocked` | string[] | External plugin ids never loaded. |
| `sideload` | boolean | Allow installing from a manifest URL, zip, directory or project file (default true). |
| `defaultActive` | string[] | Plugin ids active in a fresh project. |

### `services`

| Field | Type | Meaning |
| --- | --- | --- |
| `builtins` | boolean | `false` hides the built-in starter services. |
| `catalog` | object[] | Curated entries: `id`, `name`, `kind` (`wms`, `wfs`, `wmts`, `xyz`, `arcgis`, `csw`), optional `category`, and non-empty `fields` (string, number or boolean values). |

### `sharing`

| Field | Type | Meaning |
| --- | --- | --- |
| `shareUrl` | string | Projects server URL (`http(s)://…`), or `off` to remove Share and the Gallery. |
| `collabUrl` | string | Live collaboration relay (`ws(s)://…`). |
| `embedOrigins` | string[] | Origins allowed to drive a framed app (`https://host`), or `*` for any. |

### `geolens`

| Field | Type | Meaning |
| --- | --- | --- |
| `url` | string | Default GeoLens server (`http(s)://…`), `same-origin`, or `off`. |

### `ai`

| Field | Type | Meaning |
| --- | --- | --- |
| `enabled` | boolean | Expose the same-origin AI assistant route (default false). |
| `model` | string | Default assistant model id. |

### `branding`

| Field | Type | Meaning |
| --- | --- | --- |
| `appName` | string | App name in the toolbar and tab title, at most 60 characters. |
| `welcome` | boolean | `false` skips the first-launch welcome wizard. |

## Omitted versus empty

For `capabilities` and `plugins.allowed`, leaving the field out and writing `[]`
mean opposite things. Omitted means "no restriction from this file"; `[]` means
"nothing is granted/allowed".

## Plugin precedence
An id in `blocked` is never loaded, even if it is also in `allowed`. When
`allowed` is present, any non-bundled external id not in it is not loaded.

The evaluator checks sideload permission first, then `blocked`, then `allowed`.
Bundled drop-ins under `public/plugins/` are exempt from `allowed` and
`sideload`, but still honor `blocked`. Built-in plugins are not external plugins
and are not governed by these load restrictions.

For URL plugins, GeoLibre must fetch `plugin.json` to learn the id. A denied id
never has its entry or stylesheet fetched or its code imported. Denials appear
as external plugin load issues.

With `sideload: false`, manifest URL, zip and directory controls disappear and
programmatic installs refuse. Project-supplied manifest URLs produce no trust
prompt and cannot be trusted into settings. Previously installed URLs stay in
settings, but only URLs recognized by permitted entries in the current registry
may load (plus bundled drop-ins). If that registry is unavailable, installed URLs
fail closed; bundled drop-ins can still load. Existing file-installed archives
and additional directories cannot load. Each skipped configured directory is
reported as an external plugin load issue without reading its contents.
Each settings-triggered or forced scan checks current registry membership before
reusing a previous load. A previously loaded URL that is no longer approved
is unloaded, including when the registry is unavailable. Its installed URL and
integrity pin remain until the user uninstalls it; registry approval returning
does not silently trust changed code. Denied registry entries are hidden in
the marketplace, but their installed source URLs remain removable in Settings.

`defaultActive` marks permitted, loaded external plugins for activation in a
fresh project. It does not override a saved project's active plugin list and
does not allow a denied plugin to load. URL updates preserve these deployment
defaults for later fresh projects. Without a `plugins` section, existing loading
and activation behavior is unchanged.

Plugin policy is client-side enforcement only, not a server security boundary:
a modified client can bypass it. It does not provide signing or sandboxing.

## Precedence between sources

The order, highest first, is:

1. final `deployment.json` policy (including container environment overrides)
2. runtime environment (`window.__GEOLIBRE_DEPLOYMENT_ENV__`)
3. build-time environment

The legacy `admin-profile.json` is still honoured for the interface only when
the selected policy has no non-empty, valid `interface` section.

## Versioning

New fields are additive and keep `version: 1`. A document with any other
version is ignored with a console warning.

## Validation

The client parser is lenient and works section by section:

- A section with any invalid field, or any unknown key inside it, is dropped
  whole with a console warning. The other sections still apply.
- An unknown capability name drops the entire `capabilities` section, so the
  deployment falls back to environment settings or defaults (it does not grant
  nothing). Check the console if a restriction seems missing.
- Unknown top-level keys are ignored with one warning.
- Non-JSON content or a non-object is ignored silently.

The container validates strictly: it rejects unknown keys, duplicate or invalid
ids, service ids that collide after trimming, and numeric service field values
beyond the safe-integer range, none of which JSON Schema alone can all express.

## Desktop

Place `deployment.json` in Tauri's `<app_config_dir>` (see
[UI Profiles](ui-profiles.md) for the legacy profile locations). For the
standard `org.geolibre.desktop` application identifier, the paths are:

| OS | Policy path |
| --- | --- |
| Linux | `$XDG_CONFIG_HOME/org.geolibre.desktop/deployment.json`, or `~/.config/org.geolibre.desktop/deployment.json` when `XDG_CONFIG_HOME` is unset |
| macOS | `~/Library/Application Support/org.geolibre.desktop/deployment.json` |
| Windows | `%APPDATA%\org.geolibre.desktop\deployment.json` (normally `C:\Users\<user>\AppData\Roaming\org.geolibre.desktop\deployment.json`) |

These follow Tauri's [app config directory](https://v2.tauri.app/reference/javascript/api/namespacepath/#appconfigdir).
Sandboxed installations may resolve the directory inside their sandbox;
custom builds with a different application identifier use that identifier
instead.

The `read_deployment_policy` command returns raw UTF-8 text, or `null` when
the file is absent. A leading UTF-8 BOM is accepted by the parser. The selected
policy is applied before the first render, including capability restrictions,
without rebuilding the app. Restart GeoLibre after changing the file; changes
are not watched.

An existing config-dir file is authoritative, even if empty, malformed or of
an unsupported version: it yields no policy rather than falling back to a
bundled or web file. Config-dir and web policies are never merged. When the file
is absent, GeoLibre fetches `<base>/deployment.json` instead. Other read errors
(including permission failures) produce a console warning in every build and
fall back to that same web file. Unsupported versions also warn in every build.
With no file in either location, existing behavior is unchanged.

A non-empty, valid policy `interface` replaces the legacy profile whole; an
absent, empty, or dropped invalid `interface` leaves the legacy profile
eligible. The config directory is user-writable: this is desktop provisioning,
not a security boundary or server-side enforcement.

## Docker

The image writes the generated public file to
`/usr/share/nginx/html/deployment.json` on every boot, served at
`/deployment.json` with `Cache-Control: no-store`, `Content-Type:
application/json` and `X-Content-Type-Options: nosniff`. The source file is
selected by `GEOLIBRE_DEPLOYMENT_FILE` (for example
`/etc/geolibre/deployment.json`); mount it read-only there, never over the
generated output. With no source or overrides, the image writes
`{"version":1}`, which adds no capability restriction.

The source file is strictly validated before any environment overrides are
applied. Nonblank `GEOLIBRE_*` values then override their corresponding fields;
blank values count as unset. Invalid input stops boot and cannot be repaired by
an override.

```bash
docker build -t geolibre-policy:local .
docker run --rm -p 8080:80 \
  -v "$PWD/deployment.json:/etc/geolibre/deployment.json:ro" \
  -e GEOLIBRE_DEPLOYMENT_FILE=/etc/geolibre/deployment.json \
  -e GEOLIBRE_CAPABILITIES=data:add,export:data \
  geolibre-policy:local
```

Build the image from merged `main` to obtain runtime policy support until a
containing release is verified; configuration changes do not require rebuilding.

| Variable | Policy field |
| --- | --- |
| `GEOLIBRE_CAPABILITIES` | `capabilities`: comma-separated names, or `none` for no grants |
| `GEOLIBRE_SERVICES_FILE` | `services.catalog` |
| `GEOLIBRE_BUILTIN_SERVICES=off` | `services.builtins: false` |
| `GEOLIBRE_SHARE_URL` | `sharing.shareUrl` |
| `GEOLIBRE_COLLAB_URL` | `sharing.collabUrl` |
| `GEOLIBRE_EMBED_ORIGINS` | `sharing.embedOrigins` |
| `GEOLIBRE_GEOLENS_URL` | `geolens.url` |
| `GEOLIBRE_APP_NAME` | `branding.appName`: whitespace collapsed, cut to 60 characters |
| `GEOLIBRE_AI_URL` / `GEOLIBRE_AI_MODEL` | `ai.enabled: true` / `ai.model` |

The boot log has one `Deployment policy: <path> from <VAR> = <value>` line per
override. Tokens never appear in it, and a query string or fragment on a URL is
replaced with `[redacted]`.

Invalid input stops the boot with an `ERROR:` line that names the JSON path (for
example `ERROR: GEOLIBRE_DEPLOYMENT_FILE capabilities[1] must be one of: ...`),
so nginx never starts with a weaker policy than you asked for. A file with
`ai.enabled: true` also needs `GEOLIBRE_AI_URL`, `GEOLIBRE_AI_PROXY_URL` and
`GEOLIBRE_AI_PROXY_TOKEN`, otherwise the boot fails.

`GEOLIBRE_CAPABILITIES` overrides the final policy's client grants at container
generation time. The generated policy is what nginx enforces; build-time client
grants alone do not configure nginx.

!!! warning "Public file, no secrets"
    `deployment.json` is served to every browser. Never put secrets in it. The
    AI proxy URL and token, the sidecar token, trusted proxies, Basic Auth and
    CSP stay in server environment variables and files.

!!! warning "Client hiding is not enforcement"
    Hiding or removing an interface element does not stop someone with browser
    devtools. Nginx enforcement applies only to the bundled Docker routes; it
    does not restrict desktop processing, browser WASM, separately exposed
    sidecars, or plugin execution. See
    [Deployment Capabilities](deployment-capabilities.md) and
    [Self-Hosting](self-hosting.md#container-policy-enforcement).
