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
| `join` | `displayName, color, hostToken?, inviteToken?, identityToken?` | first frame after connect; the relay assigns the `clientId` (returned in `welcome`) |
| `snapshot` | `project, rev` | a debounced project push; co-editors only |
| `presence` | `cursor?, view?` | throttled cursor / viewport |
| `set-mode` | `mode` | host only |
| `set-participant-mode` | `clientId, canEdit` | host only; pin one guest to can-edit / view-only (#754; persisted per participant key, so it survives a reconnect only for identity/invite joins — see *Moderation*) |
| `mint-invite` | `role, maxUses?` | host only; mint a co-edit or view-only invite link |
| `revoke-invite` | `token` | host only; invalidate an active invite link |
| `set-session-config` | `requireIdentity` | host only; mandate signed-in identity to join |
| `set-layer-locks` | `lockedLayerIds` | host only; mark specific layer IDs read-only |
| `kick-participant` | `clientId, reason?` | host only; disconnect a participant |
| `block-participant` | `clientId, reason?` | host only; disconnect and bar that participant key from rejoining (see the caveat under *Moderation*) |
| `chat` | `text, coordinate?` | a chat message, with an optional attached map coordinate (#754) |

Server → client:

| type | payload | notes |
| --- | --- | --- |
| `welcome` | `clientId, role, mode, participants[], snapshot \| null, presence, chat[], rev, requireIdentity, identitySupported, lockedLayerIds, invites[]` | sent once on join; the late-joiner bootstrap |
| `snapshot` | `project, origin, rev` | fan-out of a peer's snapshot |
| `presence` | `clientId, cursor?, view?` | fan-out of a peer's presence |
| `participants` | `participants[]` | on join / leave / role / permission change; each carries `editOverride` and `identity` |
| `mode` | `mode` | host changed the session mode |
| `invite-created` | `invite` | fan-out of a new invite link created by host |
| `invite-revoked` | `token` | fan-out when host revokes an invite link |
| `session-config` | `requireIdentity` | broadcast when session identity policy changes |
| `layer-locks` | `lockedLayerIds` | broadcast when host locks/unlocks layer IDs |
| `kicked` | `reason` | sent to a participant who was kicked or blocked by the host |
| `chat` | `message` | fan-out of a chat message (echoed to the sender, so order is server-authoritative) (#754) |
| `error` | `code, message` | e.g. `forbidden`, `too-large`, `identity-required`, `identity-unavailable`, `layer-locked` |

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
`set-participant-mode` require the host token. Oversized snapshots (> 10 MB by
default) are rejected with `error: too-large`; the cap sits under Cloudflare's
32 MiB ceiling on a received WebSocket message. Hosted snapshots are stored in
chunks across rows of a SQLite table, because a Durable Object caps both a
key/value entry and a single SQLite string at 2 MB — well under what portable
GeoJSON from local files and external plugins needs. An empty session is
reclaimed after a TTL via a storage alarm, which drops the chunks with the rest
of the database.

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
`error: forbidden`, exactly like the session-wide view-only path. An override is
also persisted against the guest's **participant key**, so it is reapplied when
they rejoin — but only for identity- and invite-based joins, for the same reason
a block is (see *Moderation* below): an anonymous guest arrives with a fresh
`clientId` and therefore a fresh key, so their override reverts to the session
default on reconnect. The host roster surfaces a per-guest toggle; other
participants see each guest's current permission read-only.

The host token (returned only to the creator) gates `set-mode` and
`set-participant-mode`, so a guest can't escalate the session or another guest.
Codes are unguessable and sessions auto-expire. The relay assigns each
participant's `clientId` server-side (the client-supplied value is ignored) so
one participant can't claim another's identity, and it validates the `color` to
a hex value before storing/broadcasting it.

### Signed-in identity (optional)

A joiner may present an `identityToken`. It is **not** self-reported JSON: the
relay verifies an HMAC-SHA256 signature over the token's payload segment before
it will populate `participant.identity`, so a client cannot mint an account,
impersonate another user, or wear the roster's verified badge. The format is

```
<base64url(payloadJSON)>.<base64url(hmacSha256(base64url(payloadJSON)))>
```

with payload claims `{ userId, username, provider?, exp? }`. `verifyIdentityToken`
in `@geolibre/collab-core` is the single implementation both relays call, and
`signIdentityToken` alongside it mints one.

Identity is **off unless a deployment opts in** by setting the signing secret
shared with its issuer — `COLLAB_IDENTITY_SECRET` (a Worker secret for
`workers/collab`, an environment variable for `workers/collab-node`). With no
secret configured:

- every `identityToken` verifies to null, so all joiners are anonymous;
- `requireIdentity` cannot be turned on — `POST /sessions` answers `400` and
  `set-session-config` answers `error: identity-unavailable`, rather than arming
  a gate that would reject every guest including the host's own collaborators;
- `GET /health` and every `welcome` report `identitySupported: false`, which is
  how the Collaborate dialog decides to hide the "require a signed-in account"
  option entirely.

GeoLibre itself ships no sign-in flow yet, so the stock deployment leaves the
secret unset and the whole identity path dormant. The protocol and relay support
are in place for a deployment that fronts the relay with its own issuer.

### Moderation

`kick-participant` disconnects a participant. `block-participant` also records
their **participant key** so the relay refuses the next join. That key is
`user:<userId>` for a verified identity, `invite:<token>` for an invite-based
join, and otherwise `anon:<clientId>` — where `clientId` is minted fresh on
every join.

The same key backs a persisted per-participant override, so both carry the same
caveat: a block is durable only for identity- and invite-based joins. **An anonymous
guest can rejoin simply by reconnecting**, since they arrive with a new
`clientId` and therefore a new key. Blocking is a moderation convenience, not a
security boundary; a session that needs an enforceable ban has to require an
invite or a signed-in identity.

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

> **Operator note:** `POST /sessions` validates the request `Origin` (or
> `Referer`) against `ALLOWED_ORIGINS` via `isAllowedOrigin` (defaults to the
> hosted origins (`geolibre.app`, `web.geolibre.app`, its legacy
> `viewer.geolibre.app` alias, `studio.geolibre.app`, and
> `collab.geolibre.app`), single-label HTTPS deployment hosts under
> `*.geolibre-preview.pages.dev`, loopback hosts (`localhost` and
> `127.0.0.1`), and `tauri://localhost`). Nested or custom-port preview hosts
> and look-alike domains are rejected; the shared `opengeos.org` GitHub Pages
> preview origin is deliberately not trusted) as browser-origin filtering
> and defense-in-depth (not authentication or a general server-side access gate)
> and enforces a per-IP `checkRateLimit` (10 requests / 60 s). `Access-Control-Allow-Origin: *` is
> still sent on responses so non-browser clients (e.g. Tauri) are not blocked by
> CORS; non-browser clients may omit these headers and remain supported, unless a
> verifiable credential requirement is added. Configure `ALLOWED_ORIGINS`
> (comma-separated list) to restrict which browser origins may create sessions in
> production.

## Feature flag

Set `VITE_GEOLIBRE_COLLAB_URL` to the relay base (e.g.
`wss://collab.geolibre.app`, or `ws://127.0.0.1:8787` for `wrangler dev`). When
unset, the hook is inert and all collaboration UI is hidden, so production builds
ship the feature dark. The Tauri CSP `connect-src` must list the wss host (the
existing `https:` directive does **not** authorize `wss:`).

In the Docker image the same setting is available at **container runtime** as
`-e GEOLIBRE_COLLAB_URL=…`: the entrypoint validates it, writes it into
`geolibre-runtime-config.js`, and `resolveCollabBaseUrl()` prefers that over the
build-time variable — so a prebuilt image can be pointed at a self-hosted relay
without a rebuild. A value that is not `wss://` (or `ws://` on loopback) fails the
container boot rather than silently leaving collaboration dark. The entrypoint also
substitutes the relay's origin into the nginx CSP's `connect-src`
(`__GEOLIBRE_COLLAB_CONNECT_SRC__` in `docker/nginx.conf`), since that directive
has no bare `wss:` — so unlike the desktop build below, the web/Docker path needs
no manual CSP edit. See
[Run with Docker](getting-started.md#self-hosted-sharing-and-collaboration-servers).

> **Self-hosting note:** the desktop CSP pins `wss://collab.geolibre.app` (plus
> `ws://localhost`/`127.0.0.1` for dev). Pointing the desktop build at a
> different relay means updating `connect-src` in
> `apps/geolibre-desktop/src-tauri/tauri.conf.json` and rebuilding — the CSP and
> the `VITE_GEOLIBRE_COLLAB_URL` flag are independent knobs. The web build
> inherits the page's CSP instead, so it only needs the env var.

## Deploying the relay (`collab.geolibre.app`)

Two hosts implement the same protocol and import the same permission/validation
core:

- `workers/collab` is the Cloudflare Durable Object used by the hosted service.
- `workers/collab-node` is the self-hostable Node/SQLite relay. It is included
  as `geolibre-collab` in the root `docker-compose.yml`; its persistent database
  is mounted at `/data/collab.sqlite`. Configure `COLLAB_MAX_SNAPSHOT_BYTES`
  (default 10,000,000) and `COLLAB_IDLE_TTL_MS` (default two hours) when needed.

Both relay implementations accept `COLLAB_MAX_SNAPSHOT_BYTES` as a positive
integer number of bytes. For the Cloudflare relay, set it as a Worker variable,
for example:

```toml
[vars]
COLLAB_MAX_SNAPSHOT_BYTES = "10000000"
```

The configured value must remain below the deployment platform's WebSocket
message-size limit.

The hosted relay deploys to Cloudflare Workers the same way as `workers/viewer`:

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

- `npm run test:worker` typechecks both relays and runs the Node relay's socket
  integration suite.
- `npm run test:frontend` runs `tests/collab-protocol.test.ts` (protocol
  round-trip including the `set-participant-mode` / `chat` frames,
  `resolveCollabBaseUrl` validation, echo-suppression logic, and the
  `participantCanEdit` effective-permission helper), plus the shared relay
  conformance suite.

### Testing the full feature locally

Collaboration is dark until `VITE_GEOLIBRE_COLLAB_URL` points at a running
relay, so local testing has two parts: run the relay, then run the app against
it.

1. **Start a relay** in one terminal. For the Cloudflare implementation:

   ```bash
   cd workers/collab && npx wrangler dev --port 8787 --local
   # → Ready on http://localhost:8787
   ```

   Or run the self-hostable Node implementation:

   ```bash
   npm run build -w geolibre-collab-node
   npm start -w geolibre-collab-node
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
