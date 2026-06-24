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
- **Chat** — short text messages with an optional attached map coordinate (#754).
  Bounded recent history is relayed to late joiners; never written to a project.
- **Permissions** — the host's per-participant view-only / can-edit overrides
  (#754), broadcast on the participant list as `editOverride`.

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
| `set-participant-mode` | `clientId, canEdit` | host only; pin one guest to can-edit / view-only (#754) |
| `chat` | `text, coordinate?` | a chat message, with an optional attached map coordinate (#754) |

Server → client:

| type | payload | notes |
| --- | --- | --- |
| `welcome` | `clientId, role, mode, participants[], snapshot \| null, presence, chat[], rev` | sent once on join; the late-joiner bootstrap |
| `snapshot` | `project, origin, rev` | fan-out of a peer's snapshot |
| `presence` | `clientId, cursor?, view?` | fan-out of a peer's presence |
| `participants` | `participants[]` | on join / leave / role / permission change; each carries `editOverride` |
| `mode` | `mode` | host changed the session mode |
| `chat` | `message` | fan-out of a chat message (echoed to the sender, so order is server-authoritative) (#754) |
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
`latestSnapshot`, a monotonic `rev`, the `mode`, the `hostToken`, and a bounded
`chat` log; presence and per-participant permission overrides are kept on the
in-memory / per-socket attachment. Server-side enforcement: a `snapshot` from a
guest who cannot edit (session `view-only`, or a host-set per-participant
view-only override) is dropped with an `error: forbidden`; `set-mode` and
`set-participant-mode` require the host token. Oversized snapshots (> ~1 MiB, the
Cloudflare frame cap) are rejected with `error: too-large`. An empty session is
reclaimed after a TTL via a storage alarm.

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
- `components/layout/CollaborationStatusBadge.tsx` — the persistent on-canvas
  badge that hosts the participant roster (with the host's per-participant
  permission toggles) and the chat drawer (#754). `useCollaboration` is owned by
  `DesktopShell` and passed to both the dialog and this badge, so they share one
  socket. `participantCanEdit()` (in `lib/collab-protocol.ts`) is the shared
  effective-permission helper used by the relay-mirrored client UI.

## Identity & permissions (MVP)

Anonymous. The host starts a session and shares a code/link; joiners pick a
display name and a color. The host chooses the session **mode**:

- **view-only** — guests can watch and see presence, but their snapshot pushes
  are rejected server-side.
- **co-edit** — anyone with the link can edit.

**Per-participant overrides (#754).** Beyond the session-wide mode, the host can
pin an individual guest with `set-participant-mode { clientId, canEdit }`. The
relay records the override on that socket's attachment (so it survives a
hibernation wake) and re-broadcasts the participant list with an `editOverride`
field (`true` / `false`, or `null` to follow the session mode). Effective edit
permission, computed identically on the client and the relay, is: the host
always edits; otherwise the override wins; otherwise the session mode applies. A
guest pinned to view-only has their `snapshot` pushes rejected with
`error: forbidden`, exactly like the session-wide view-only path. Overrides are
keyed to the per-socket `clientId`, so a guest who reconnects reverts to the
session default (acceptable for the ephemeral MVP). The host roster surfaces a
per-guest toggle; other participants see each guest's current permission read-only.

The host token (returned only to the creator) gates `set-mode` and
`set-participant-mode`, so a guest can't escalate the session or another guest.
Codes are unguessable and sessions auto-expire. The relay assigns each
participant's `clientId` server-side (the client-supplied value is ignored) so
one participant can't claim another's identity, and it validates the `color` to
a hex value before storing/broadcasting it.

## Chat (#754)

A lightweight, in-session text channel. A `chat { text, coordinate? }` frame is
validated server-side (non-empty, trimmed, capped at 2000 chars; the coordinate
runs through the same finite-number sanitizer as presence) and fanned out to
**every** participant including the sender, so the relay's ordering is the single
source of truth (clients render from the echo rather than optimistically). Each
message carries a server-assigned `id` and `ts`. The relay keeps a bounded,
persisted history (last 50 messages) so a late joiner (or a post-hibernation
welcome) sees the recent conversation via the `welcome.chat[]` bootstrap. Chat
is open to everyone in the session, including view-only guests; only project
edits are gated. A message can attach the sender's current map center as a
clickable coordinate that recenters the recipient's map. Chat lives on the
on-canvas status badge so it is reachable while working on the map; it is
ephemeral and never written to a project file.

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

> **Self-hosting note:** the desktop CSP pins `wss://collab.geolibre.app` (plus
> `ws://localhost`/`127.0.0.1` for dev). Pointing the desktop build at a
> different relay means updating `connect-src` in
> `apps/geolibre-desktop/src-tauri/tauri.conf.json` and rebuilding — the CSP and
> the `VITE_GEOLIBRE_COLLAB_URL` flag are independent knobs. The web build
> inherits the page's CSP instead, so it only needs the env var.

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

Automated:

- `npm run test:worker` typechecks `workers/collab`.
- `npm run test:frontend` runs `tests/collab-protocol.test.ts` (protocol
  round-trip including the `set-participant-mode` / `chat` frames,
  `resolveCollabBaseUrl` validation, echo-suppression logic, and the
  `participantCanEdit` effective-permission helper).

### Testing the full feature locally

Collaboration is dark until `VITE_GEOLIBRE_COLLAB_URL` points at a running
relay, so local testing has two parts: run the relay, then run the app against
it.

1. **Start the relay** (the Durable Object) in one terminal:

   ```bash
   cd workers/collab && npx wrangler dev --port 8787 --local
   # → Ready on http://localhost:8787
   ```

2. **Start the app pointing at that relay** in another terminal:

   ```bash
   VITE_GEOLIBRE_COLLAB_URL=ws://127.0.0.1:8787 npm run dev
   # → http://localhost:5173
   ```

   Or put `VITE_GEOLIBRE_COLLAB_URL=ws://127.0.0.1:8787` in
   `apps/geolibre-desktop/.env.local` so you don't repeat it. With the variable
   unset the Collaborate menu item stays hidden — that is the feature flag
   working. (For the desktop shell use `npm run tauri:dev` with the same
   variable; the Tauri CSP already allows `ws://127.0.0.1:*` / `ws://localhost:*`.)

3. **Open two independent windows** at `http://localhost:5173` — a normal window
   plus an incognito window works well so they don't share state.

4. **Drive a session:**
   - Window A: **Project → Collaborate…**, enter a name, pick a color, **Start
     session** (choose *Anyone can edit*). Copy the session code or the share
     link.
   - Window B: open the share link directly (the Collaborate dialog auto-opens
     with the code prefilled — just enter a name and **Join**), or open
     **Project → Collaborate…** and paste the code.
   - Verify: B immediately sees A's existing layers; adding/removing a layer,
     changing a style, or panning in A reflects in B within ~300 ms; each window
     shows the other's live **cursor** and a dashed **viewport rectangle**;
     toggling A (the host) to *view-only* blocks B's edits.
   - Verify Parts 3 & 4 (#754) via the on-canvas status badge (bottom-left,
     click to expand): A (the host) can flip B between **Can edit** and
     **View-only** per-participant in the roster, and either window can send a
     **chat** message (optionally attaching the current map center, which the
     other side can click to recenter).

**Relay-only smoke test (no UI):** with `wrangler dev` running, `POST` to
`http://127.0.0.1:8787/sessions` to mint a code, then open a WebSocket to
`ws://127.0.0.1:8787/sessions/<code>/ws` and exchange `join` / `snapshot` /
`presence` frames — the quickest way to confirm the relay independent of the
front end.
