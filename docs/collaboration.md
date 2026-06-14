# Real-time collaboration (live-synced sessions)

> Status: **experimental MVP** (issue [#307](https://github.com/opengeos/GeoLibre/issues/307)).
> Disabled unless `VITE_GEOLIBRE_COLLAB_URL` is configured.

GeoLibre's project sharing is otherwise snapshot-based (upload to
share.geolibre.app). This feature adds a **live** mode: several people open the
same session and see each other's layer/style/view edits in real time, with
presence cursors and viewport indicators. It targets classrooms, workshops, and
small teams.

## What syncs

- **Project state** — layers, layer groups, styles, basemap, and the map view
  (camera). Broadcast as whole-project snapshots.
- **Presence** — each participant's live cursor position and viewport rectangle,
  plus a name + color. Presence is ephemeral and never persisted.

## Architecture

```
 Desktop/Web app A                Cloudflare Worker                Desktop/Web app B
 ┌────────────────┐   wss     ┌──────────────────────────┐  wss   ┌────────────────┐
 │ useCollaboration│ ───────► │  CollabSession (Durable   │ ◄───── │ useCollaboration│
 │  (Zustand store)│ ◄─────── │  Object): holds latest    │ ─────► │  (Zustand store)│
 └────────────────┘  snapshot │  snapshot + presence map, │ snapshot└────────────────┘
                     /presence │  fans out to all peers    │ /presence
                               └──────────────────────────┘
```

There is **one centralized relay** (a Cloudflare Durable Object), not a P2P
mesh. The DO holds the latest project snapshot so a late joiner is bootstrapped
immediately, and fans every message out to the other connected sockets.

### Why a Durable Object relay (and not CRDT/WebRTC)

The MVP deliberately picks the simplest thing that works:

- The store is already the single source of truth, and
  `serializeProject`/`parseProject` already produce a validated, normalized wire
  format. `useEmbedBridge` already broadcasts exactly this over `postMessage`.
  The collaboration adapter is that same pattern over a WebSocket.
- A **whole-snapshot, last-write-wins** model is trivially consistent: the last
  snapshot the relay sees wins, full stop. Mutation-level merging would need
  per-field clocks; a CRDT (Yjs/Automerge) would add a sizeable client bundle
  and a second source of truth alongside Zustand.
- The relay builds directly on the existing `workers/viewer` Cloudflare setup.

CRDT / per-action mutation transport is the documented **v2** path (see
Limitations).

## Sync protocol

All frames are JSON. `CollabMessage` is a discriminated union on `type`. See
`apps/geolibre-desktop/src/lib/collab-protocol.ts` for the authoritative types
(shared by client and worker).

Client → server:

| type | payload | notes |
| --- | --- | --- |
| `join` | `displayName, color, hostToken?` | first frame after connect; the relay assigns the `clientId` (returned in `welcome`) |
| `snapshot` | `project, rev` | a debounced project push; co-editors only |
| `presence` | `cursor?, view?` | throttled cursor / viewport |
| `set-mode` | `mode` | host only |

Server → client:

| type | payload | notes |
| --- | --- | --- |
| `welcome` | `clientId, role, mode, participants[], snapshot \| null, rev` | sent once on join; the late-joiner bootstrap |
| `snapshot` | `project, origin, rev` | fan-out of a peer's snapshot |
| `presence` | `clientId, cursor?, view?` | fan-out of a peer's presence |
| `participants` | `participants[]` | on join / leave / role change |
| `mode` | `mode` | host changed the session mode |
| `error` | `code, message` | e.g. `forbidden`, `too-large` |

### Echo / feedback-loop prevention

The adapter caches `lastAppliedContent` (the serialized project string). Before
applying an inbound snapshot it sets `lastAppliedContent` to the
post-normalization string, then applies via `loadProject`. The store
subscription that `loadProject` triggers re-serializes to an identical string and
is suppressed, so a remote apply is never re-broadcast — the exact trick
`useEmbedBridge` uses with `lastPostedContent`. Frames whose `origin` is our own
`clientId` are also ignored defensively (the relay already excludes the sender).

### Undo interaction

Remote snapshots are applied through `loadProject`, which ends with
`clearHistory()`. This keeps remote edits out of the local undo stack — but it
also means **a collaborator's edit clears your undo history**. That is an
accepted MVP limitation; a coalesced-history option is a v2 item.

## Durable Object (`workers/collab`)

- `POST /sessions` — host creates a session: generates a short base32 code, mints
  a host token, stores `{ mode, hostToken }`, returns `{ sessionId, hostToken,
  mode }` to the host only.
- `GET /sessions/:id/ws` — WebSocket upgrade, routed to
  `env.COLLAB_SESSION.get(idFromName(id))`.

`CollabSession` uses the **WebSocket Hibernation API** so idle sessions evict
from memory while keeping sockets open. Per-socket participant metadata is kept
via `ws.serializeAttachment()` (survives hibernation). Durable storage holds the
`latestSnapshot`, a monotonic `rev`, the `mode`, and the `hostToken`; presence is
in-memory only. Server-side enforcement: a `snapshot` from a guest while the
session is `view-only` is dropped with an `error: forbidden`; `set-mode` requires
the host token. Oversized snapshots (> ~1 MiB, the Cloudflare frame cap) are
rejected with `error: too-large`. An empty session is reclaimed after a TTL via a
storage alarm.

## Frontend

- `lib/collab-protocol.ts` — shared message types.
- `lib/collab-client.ts` — WebSocket transport, `resolveCollabBaseUrl()` (wss/loopback
  validation, returns `null` when unset), exponential-backoff reconnect.
- `hooks/useCollaboration.ts` — orchestration: subscribes to the store
  (debounced, deduped snapshot push for co-editors), reads `map` `mousemove`
  (throttled) and `moveend` for presence, routes inbound frames, and exposes
  start/join/leave/set-mode actions. Inert no-op when `resolveCollabBaseUrl()` is
  `null`.
- `lib/build-project-snapshot.ts` — the shared `buildProjectSnapshot()` lifted
  from `useEmbedBridge` so the bridge and the adapter share one definition.
- Store: an ephemeral `collaboration` slice (`packages/core`), excluded from the
  project file (never read by `projectFromStore`) and from undo history (never
  added to `partialize`).
- `components/layout/RemoteCursorsOverlay.tsx` — renders remote cursors as
  MapLibre Markers and viewport rectangles as a dedicated GeoJSON line layer.
- `components/layout/CollaborateDialog.tsx` + a flag-gated `TopToolbar` entry.

## Identity & permissions (MVP)

Anonymous. The host starts a session and shares a code/link; joiners pick a
display name and a color. The host chooses the session **mode**:

- **view-only** — guests can watch and see presence, but their snapshot pushes
  are rejected server-side.
- **co-edit** — anyone with the link can edit.

The host token (returned only to the creator) gates `set-mode`, so a guest can't
escalate the session to co-edit. Codes are unguessable and sessions auto-expire.
The relay assigns each participant's `clientId` server-side (the client-supplied
value is ignored) so one participant can't claim another's identity, and it
validates the `color` to a hex value before storing/broadcasting it.

> **Operator note:** `POST /sessions` is unauthenticated and currently responds
> with `Access-Control-Allow-Origin: *`, so any page can create sessions. This is
> acceptable for the experimental MVP but should be restricted to the app's own
> origin(s) before a wider rollout to avoid capacity abuse.

## Feature flag

Set `VITE_GEOLIBRE_COLLAB_URL` to the relay base (e.g.
`wss://collab.geolibre.app`, or `ws://127.0.0.1:8787` for `wrangler dev`). When
unset, the hook is inert and all collaboration UI is hidden, so production builds
ship the feature dark. The Tauri CSP `connect-src` must list the wss host (the
existing `https:` directive does **not** authorize `wss:`).

## Deploying the relay (`collab.geolibre.app`)

The relay deploys to Cloudflare Workers the same way as `workers/viewer`:

- **CI:** `.github/workflows/deploy-collab.yml` deploys on any push to `main`
  that touches `workers/collab/**` (or via manual `workflow_dispatch`). It reuses
  the existing `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` repo secrets — the
  token needs the **Workers Scripts Write** permission (Cloudflare's "Edit
  Cloudflare Workers" template includes it). Deploying the Durable Object is part
  of the same script upload, so no separate Durable Objects permission is needed.
- **Manual:** `cd workers/collab && npx wrangler deploy`.

`wrangler.toml` already declares the `collab.geolibre.app` custom-domain route and
the SQLite Durable Object migration, so the first deploy provisions DNS, TLS, and
the DO class automatically — no manual Cloudflare dashboard steps. SQLite-backed
Durable Objects are available on the free Workers plan.

Once the relay is live, point the app at it by setting
`VITE_GEOLIBRE_COLLAB_URL=wss://collab.geolibre.app` in the web/Pages build
environment. Until that env var is set, the feature stays dark.

## Limitations / v2

- **Last-write-wins**: simultaneous co-edits race; the last debounced snapshot
  wins and the slower edit is overwritten. Presence helps users avoid colliding.
- **Payload size**: layers can embed `FeatureCollection`s. `projectFromStore`
  already strips redundant `geojson` for URL-backed layers, but a large
  in-memory/local-file layer can exceed the ~1 MiB frame cap and is rejected with
  a clear error (share via URL instead). v2: diff / chunked layer sync.
- **Undo**: a remote apply clears local undo (see above).
- v2 directions: per-action mutation or CRDT transport, coalesced remote-apply
  history, richer permission/identity (tie to share.geolibre.app accounts).

## Testing

- `npm run test:worker` typechecks `workers/collab`.
- `npm run test:frontend` runs `tests/collab-protocol.test.ts` (protocol
  round-trip, `resolveCollabBaseUrl` validation, echo-suppression logic).
- Local end-to-end: `wrangler dev` in `workers/collab`, run the app with
  `VITE_GEOLIBRE_COLLAB_URL=ws://127.0.0.1:8787`, open two browser windows, start
  a co-edit session in one and join from the other.
