# Share menu: direct project upload to share.geolibre.app

Date: 2026-06-09

## Goal

Add a **Share** action under GeoLibre's **Project** menu that uploads the current
`.geolibre.json` project directly to [share.geolibre.app](https://share.geolibre.app)
and returns a public project URL the user can copy or open. The upload must work
from both the GeoLibre Desktop (Tauri) build and the GeoLibre web build, without
the user leaving the app.

This spans two repositories:

- **GeoLibre** (this repo) — the Share UI and upload client.
- **share.geolibre.app** (the `opengeos/share.geolibre.app` repo) — a Cloudflare
  Workers + Hono + D1 + R2 app, Clerk auth, whose `POST /api/projects` endpoint
  currently accepts only a Clerk **browser session** JWT.

## The core problem and decision

A desktop or web app cannot ride a short-lived Clerk browser session to call the
API headlessly. **Decision (chosen): Personal API tokens (PAT).** The website
gains a token system (GitHub-style); the user generates a token in their
share.geolibre.app settings, pastes it into GeoLibre once, and GeoLibre sends it
as `Authorization: Bearer <token>` on upload. This is self-contained, identical
for desktop and web, and reuses the existing `Bearer`-token plumbing in the
Worker middleware.

## Architecture overview

```text
GeoLibre (desktop or web)
  Project menu > Share…
     -> ShareProjectDialog (visibility select, progress, result URL)
     -> lib/share-geolibre.ts: POST {base}/api/projects
          Authorization: Bearer glb_…   body: { filename, content, visibility }
                |
                v
share.geolibre.app Worker
  CORS (allow GeoLibre origins) -> optionalAuthMiddleware (Clerk JWT OR PAT)
     -> requireAuthMiddleware -> POST /api/projects (existing upload path)
     -> 201 { project: { projectUrl, rawJsonUrl, viewerUrl, … } }
```

The PAT is resolved to a `userId` inside the existing `optionalAuthMiddleware`, so
every endpoint already guarded by `requireAuthMiddleware` (upload, version upload,
update, delete) transparently accepts a PAT. A PAT therefore grants the same
rights as the signed-in user (like a GitHub classic PAT); fine-grained scopes are
out of scope for this iteration.

---

## Part A — share.geolibre.app changes

### A1. Database: `api_tokens` table

New table + migration (`packages/db/migrations/0002_api_tokens.sql`) and Drizzle
schema entry:

| column         | type      | notes                                            |
| -------------- | --------- | ------------------------------------------------ |
| `id`           | text PK   | `crypto.randomUUID()`                             |
| `user_id`      | text FK   | -> `users.id`, `onDelete: cascade`               |
| `name`         | text      | user-supplied label (1–100 chars)                |
| `token_hash`   | text      | SHA-256 hex of the full token, **unique**        |
| `prefix`       | text      | first 12 chars (`glb_` + 8) for display only     |
| `last_used_at` | timestamp | nullable; updated on use (best-effort)           |
| `expires_at`   | timestamp | nullable; `null` means never expires             |
| `revoked_at`   | timestamp | nullable; set on revoke (soft delete, kept for audit) |
| `created_at`   | timestamp | default `unixepoch()`                            |

Index on `token_hash` (unique) and `user_id`. Revoked tokens are retained (so a
leaked token's history is auditable) but never authenticate; a periodic cleanup
of long-expired/revoked rows is a future nicety, not in scope.

### A2. Token format and hashing

- Format: `glb_` followed by 43 url-safe base64 chars derived from 32 random
  bytes (`crypto.getRandomValues`). Shown to the user **once** at creation.
- Stored as SHA-256 hex (`crypto.subtle.digest("SHA-256", …)`). The plaintext is
  never persisted. Lookups hash the presented token and match `token_hash`.
- A shared helper `hashToken(token)` lives in `packages/shared` next to the
  existing `hashIp` helper.

### A3. Auth middleware: accept PATs

Extend `optionalAuthMiddleware` (`apps/web/src/worker/middleware.ts`):

1. Keep the existing Clerk `verifyToken` path. If it yields a `userId`, set
   `userId` and `authMethod = "clerk"`.
2. Otherwise, if the Bearer value starts with `glb_`, hash it and look it up in
   `api_tokens`. On a hit, treat the token as valid **only if** `revoked_at IS
   NULL` and (`expires_at IS NULL` OR `expires_at > now`). When valid, set
   `userId = token.user_id` and `authMethod = "token"`, and update `last_used_at`
   (fire-and-forget; failure is ignored). An expired or revoked token is treated
   as no match (stays unauthenticated, yielding 401 on guarded routes).
3. On no match, remain unauthenticated (unchanged behavior).

Add `authMethod: "clerk" | "token" | null` to `AppVariables` so token-management
routes can require a real session.

### A4. Token-management endpoints

New `tokensRouter` mounted at `/api/tokens`, all guarded by
`requireAuthMiddleware` **plus** a `requireClerkSessionMiddleware` that rejects
`authMethod === "token"` (a PAT may not mint or revoke other PATs — prevents
privilege escalation / token self-propagation):

| Method | Path              | Body / result                                                   |
| ------ | ----------------- | --------------------------------------------------------------- |
| GET    | `/api/tokens`     | `{ tokens: [{ id, name, prefix, lastUsedAt, expiresAt, revokedAt, createdAt, status }] }` |
| POST   | `/api/tokens`     | `{ name, expiresInDays? }` -> `{ token: "glb_…", id, name, prefix, expiresAt, createdAt }` (plaintext returned once) |
| DELETE | `/api/tokens/:id` | revoke (sets `revoked_at`; ownership-checked) -> `{ success: true }` |

- `expiresInDays` is optional: the allowed set is exactly `7`, `30`, `60`, `90`,
  `365` (the authoritative list is `API_TOKEN_EXPIRY_DAYS`, enforced by the Zod
  schema), or omitted/`null` for **no expiration**. The Worker computes
  `expires_at` from `now + days`; an out-of-range value is rejected.
- GET derives a `status` field per token for the UI: `active`, `expired`, or
  `revoked` (so the client does not re-implement the time math).
- `DELETE` is a **revoke** (soft delete via `revoked_at`) rather than a hard row
  delete, keeping the audit trail; the token stops authenticating immediately.
- Rate-limit `POST /api/tokens` (e.g. 20/hour) via the existing
  `rateLimitMiddleware`.

### A5. CORS for GeoLibre origins

GeoLibre calls `/api/projects` cross-origin (web build origin, and Tauri's
`tauri://localhost`). Add a CORS middleware on `/api/*` (registered before the
auth middlewares) that, when the request `Origin` is in an allowlist, reflects it
in `Access-Control-Allow-Origin`, allows `Authorization` + `Content-Type`
headers, the needed methods, and answers `OPTIONS` preflight with 204.

Allowlist (exact-match, plus localhost any-port):

- `https://geolibre.app`
- `https://viewer.geolibre.app`
- `https://share.geolibre.app` (same-origin web UI, harmless to include)
- `tauri://localhost` (desktop)
- `http://localhost:<port>` / `http://127.0.0.1:<port>` (dev)

Because auth uses a Bearer token (not cookies), `Allow-Credentials` is **not**
set and a wildcard is avoided by reflecting only allowlisted origins. The
allowlist is a small module constant so it is easy to extend.

### A6. Website Settings UI: API tokens section

Extend `apps/web/src/client/routes/settings.tsx` with an **API tokens** section:

- "Generate token" with a **name** input and an **expiration** select (30 days
  default; options 7/30/60/90/365 days and "No expiration") -> shows the new token
  once in a copyable field with a clear "you won't see this again" notice.
- List of existing tokens showing name, prefix like `glb_abcd…`, created, last
  used, and **expiry** with a status badge (Active / Expired / Revoked). Each
  active token has a **Revoke** button (confirm first). Expired and revoked
  tokens render disabled/greyed with their status.
- Wire `createToken`, `listTokens`, `revokeToken` into
  `apps/web/src/client/lib/api.ts` following the existing `apiFetch`/`getToken`
  pattern.

### A7. Docs

Update the website `README.md` API table with the `/api/tokens` endpoints and a
short "Using API tokens / uploading from GeoLibre" note.

---

## Part B — GeoLibre changes

### B1. Share client module

New `apps/geolibre-desktop/src/lib/share-geolibre.ts`:

- `SHARE_BASE_URL` from `import.meta.env.VITE_GEOLIBRE_SHARE_URL` (default
  `https://share.geolibre.app`).
- `uploadProjectToShare({ token, filename, content, visibility, signal })`:
  `POST {base}/api/projects` with the Bearer token and JSON body. Returns the
  parsed `project` (so we can surface `projectUrl`, `viewerUrl`, `rawJsonUrl`).
- Maps HTTP failures to friendly messages: 401 -> "Invalid or expired API token",
  403 -> not-allowed message, 429 -> "Too many uploads, try again later", and any
  other non-2xx (including the `400` the Worker returns for an invalid schema or
  an exceeded storage quota) -> the server's own message; a network/fetch failure
  -> offline message. Honors an `AbortSignal` and a timeout, matching the existing
  plugin-fetch patterns.

### B2. Token storage + Settings field

- Persist the token in the existing GeoLibre settings store used for runtime
  env vars / secrets (desktop: persisted settings; web: its localStorage-backed
  equivalent), under a key such as `shareGeolibreToken`.
- Add a **Sharing** field to `SettingsDialog.tsx`: a password-style input for the
  share.geolibre.app API token, with a helper link to
  `https://share.geolibre.app/settings` to create one. (Reuses the dialog's
  existing save plumbing.)

### B3. Share menu item + dialog

- Add **Share…** to the **Project** dropdown in `TopToolbar.tsx` (near
  Save / Save As), enabled when a project with at least the current map state can
  be serialized.
- New `ShareProjectDialog.tsx`:
  - Pre-fills the project title; lets the user pick **visibility** (public /
    unlisted / private, default **unlisted**).
  - If no token is stored, shows an inline prompt with a button that opens
    Settings (or the website settings page) instead of failing silently.
  - On confirm: serialize via `serializeProject` (already imported in
    `TopToolbar`), build `<name>.geolibre.json`, call `uploadProjectToShare`, show
    a spinner, then the resulting **project URL** with **Copy** and **Open**
    actions (open via the Tauri opener / `window.open`).
  - Surfaces errors from B1 inline; the dialog stays open so the user can retry.

### B4. Scope notes (YAGNI)

- **MVP creates a new project on each share.** Re-sharing the same project
  produces a new entry (the server dedupes slugs). Pushing a new **version** to an
  existing project (via `POST /api/projects/:id/versions`) and remembering the
  returned id in the project file is a deliberate **later** enhancement, not in
  this iteration.
- No thumbnail upload from GeoLibre; the website already generates thumbnails
  asynchronously.

---

## Data flow (happy path)

1. User picks **Project > Share…**, chooses visibility, clicks Share.
2. GeoLibre serializes the project and POSTs `{ filename, content, visibility }`
   with `Authorization: Bearer glb_…`.
3. Worker CORS-allows the origin, `optionalAuthMiddleware` resolves the PAT to a
   `userId`, `requireAuthMiddleware` passes, `createProjectFromUpload` validates
   the schema, stores the file in R2, writes D1 metadata, enqueues a thumbnail.
4. Worker returns `201 { project }` including `projectUrl`.
5. GeoLibre shows the URL with Copy / Open.

## Error handling

| Condition                | Where         | Behavior                                            |
| ------------------------ | ------------- | --------------------------------------------------- |
| No token stored          | GeoLibre      | Dialog prompts to add a token; links to Settings    |
| Invalid/expired token (401) | Worker     | "Invalid or expired API token"                      |
| Forbidden (403)          | Worker        | Not-allowed message                                 |
| Schema invalid (400)     | Worker        | Show server message; dialog stays open              |
| Storage quota exceeded (400) | Worker    | Show server quota message (returned as a 400)       |
| Rate limited (429)       | Worker        | "Too many uploads, try again later"                 |
| Offline / network        | GeoLibre      | Offline message; retry available                    |
| PAT used on `/api/tokens`| Worker        | 403 (token-management requires a real session)      |

## Testing

**share.geolibre.app:**
- Unit: `hashToken` determinism; token create returns plaintext once and stores
  only the hash; `optionalAuthMiddleware` resolves a valid PAT, ignores an
  invalid, **expired**, or **revoked** one, and prefers Clerk when both present.
- Route: `POST /api/projects` succeeds with a PAT and 401s without; a revoked or
  expired PAT yields 401; `POST /api/tokens` honors `expiresInDays` (and rejects
  out-of-range values) and a no-expiration token never expires; `DELETE
  /api/tokens/:id` revokes and the token immediately stops authenticating;
  `/api/tokens` CRUD enforces ownership and rejects PAT-authed token management;
  CORS preflight returns the reflected origin for an allowlisted origin and omits
  it otherwise.

**GeoLibre:**
- Unit: `uploadProjectToShare` builds the correct request and maps each error
  status to its friendly message (mocked `fetch`).
- Component: `ShareProjectDialog` shows the no-token prompt, renders the result
  URL on success, and keeps the dialog open on error.

## Out of scope

- Fine-grained token **scopes** (a PAT carries full user rights). Token
  **expiration** and revocation **are** in scope (see A1–A6).
- Version-update / re-share-in-place (noted as a follow-up).
- OAuth/device-flow auth (explicitly not chosen).
- Any change to the GeoLibre project file schema.
