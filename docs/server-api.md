# GeoLibre projects and identity API

This document defines version 1 of the HTTP contract used by GeoLibre's
Project Gallery and **Project → Share** flow. A compatible server may use any
implementation or storage engine. The reference implementation lives in
`backend/geolibre_server_api`.

## Conventions

- The base URL is configured with `GEOLIBRE_SHARE_URL` at container runtime
  (or `VITE_GEOLIBRE_SHARE_URL` at build time).
- JSON request and response bodies use `application/json` and camel-case keys.
- Dates are UTC ISO 8601 strings.
- Authenticated endpoints accept a personal API token in
  `Authorization: Bearer <token>`.
- Error responses are JSON objects with an `error` string. `401` means a
  missing, invalid, or expired token; `403` means the authenticated principal
  lacks permission; `404` deliberately covers both a missing project and a
  project the caller may not discover; `409` is a uniqueness conflict; `422`
  is malformed input; and `429` is rate limiting.
- Servers should send `Cache-Control: public, max-age=3600` on immutable raw
  project versions and may use `ETag`/conditional requests. Private responses
  must use `Cache-Control: private, no-store`.
- CORS deployments must allow `Authorization` and `Content-Type` from the
  GeoLibre web origin. Native desktop requests do not depend on CORS.

## Limits

| Field | Limit |
| --- | ---: |
| project title (derived from the uploaded project) | 100 Unicode code points |
| username | 3–39 lowercase ASCII letters, digits, or hyphens |
| slug | 1–100 lowercase ASCII letters, digits, or hyphens |
| description | 2,000 Unicode code points |
| tags | 20 tags, 40 Unicode code points each |
| project document | 50 MiB UTF-8 JSON |
| thumbnail | 5 MiB; PNG, JPEG, or WebP |
| `limit` | default 24, maximum 100 |

Servers may configure a smaller upload limit, but must return `413` and an
`error` explaining that limit.

## Visibility

- `public`: discoverable in the public listing and readable without auth.
- `unlisted`: omitted from public listings, but readable by anyone holding its
  URL. It appears in the owner's authenticated listing.
- `private`: readable and mutable only by its owner. Raw and thumbnail URLs
  require the same Bearer token as the metadata endpoint.

Changing visibility affects every version immediately. A raw URL is therefore
not a capability URL for a private project.

## Identity

### `POST /api/accounts`

Creates an account and returns a token once. This endpoint may be disabled when
an installation delegates identity to an external provider.

```json
{
  "username": "ada",
  "password": "correct horse battery staple"
}
```

Response `201`:

```json
{
  "account": {"id": "uuid", "username": "ada", "createdAt": "2026-08-03T12:00:00Z"},
  "token": "secret-token"
}
```

### `POST /api/auth/token`

Exchanges account credentials for a personal API token.

```json
{"username": "ada", "password": "correct horse battery staple"}
```

Response `200` has the same shape as account creation. Tokens are opaque and
must be stored hashed by the server.

### `DELETE /api/auth/token`

Revokes the presented Bearer token. Response: `204`.

### `GET /api/users/me`

Returns the account associated with the token:

```json
{"user": {"id": "uuid", "username": "ada", "createdAt": "2026-08-03T12:00:00Z"}}
```

An identity provider may create accounts without a username. Project creation
for such an account must return `400` with an error containing the stable,
case-insensitive sentinel text `username required`. Existing clients recognize
that phrase and direct the user to account settings.

## Projects

### Project representation

```json
{
  "id": "uuid",
  "username": "ada",
  "slug": "wetlands",
  "title": "Wetlands",
  "description": "",
  "visibility": "public",
  "thumbnailUrl": "/api/projects/uuid/thumbnail",
  "views": 12,
  "forkCount": 0,
  "versionCount": 1,
  "featured": false,
  "createdAt": "2026-08-03T12:00:00Z",
  "updatedAt": "2026-08-03T12:00:00Z",
  "tags": [],
  "rawJsonUrl": "https://example.org/ada/wetlands.geolibre.json",
  "projectUrl": "https://example.org/ada/wetlands",
  "viewerUrl": "https://example.org/?project=https%3A%2F%2Fexample.org%2Fada%2Fwetlands.geolibre.json"
}
```

URLs are absolute except that `thumbnailUrl` may be root-relative. Consumers
must resolve a relative thumbnail URL against the server base URL. Unknown
fields must be ignored.

### `POST /api/projects`

Requires auth. Creates a project and its first immutable version.

```json
{
  "filename": "Wetlands.geolibre.json",
  "content": "{\"version\":\"1.0\", ...}",
  "visibility": "public"
}
```

`content` is a string containing a valid GeoLibre project JSON document.
`filename` supplies a fallback title/slug; the project document's non-empty
title is authoritative. `visibility` is required and is `public`, `unlisted`,
or `private`.

Response `201`:

```json
{"project": {"id": "uuid", "username": "ada", "slug": "wetlands", "projectUrl": "...", "viewerUrl": "...", "rawJsonUrl": "..."}}
```

The `project` object is the full project representation. In particular,
`projectUrl` and `rawJsonUrl` are required because the current client treats a
successful response without them as invalid.

### `GET /api/projects`

Returns a page in newest-updated-first order:

```json
{"projects": [], "limit": 24, "offset": 0, "total": 0}
```

Query parameters:

- `limit`: integer page size.
- `offset`: non-negative number of matching records to skip.
- `featured=true`: return featured projects only.

Only public projects are returned. An Authorization header does not broaden a
public listing by itself. Invalid pagination is `422`.

### `GET /api/users/{username}/projects`

Requires auth. When `{username}` is the caller's username, returns
`{"projects": [...]}` containing all projects owned by the caller, including
unlisted and private projects, in newest-updated-first order. The current client
first resolves its username through `GET /api/users/me`, then calls this route.
Requesting another user's non-public listing returns `403` (an implementation
may instead return that user's public projects if it documents that extension).

### `GET /api/projects/{id}`

Returns `{"project": <project>}` if visible to the caller.

### `PATCH /api/projects/{id}`

Requires ownership. Accepted fields are `title`, `description`, `visibility`,
and `tags`. Response: `{"project": <project>}`.

### `PUT /api/projects/{id}/content`

Requires ownership. Creates a new immutable version.

```json
{"content": "{\"version\":\"1.0\", ...}"}
```

Response `201`: `{"project": <project>, "version": <positive integer>}`.

### `DELETE /api/projects/{id}`

Requires ownership. Deletes metadata and stored objects. Response: `204`.

### `POST /api/projects/{id}/forks`

Requires auth. Creates a new project owned by the caller from the visible
source's latest content. It accepts `{"visibility":"private"}` (default
`private`) and returns `201` with `{"project": <project>}`. The source
`forkCount` increases atomically.

### Raw project and website-compatible routes

- `GET /{username}/{slug}.geolibre.json` returns the latest project document
  with `Content-Type: application/json`.
- `GET /api/projects/{id}/versions/{version}` returns an immutable historical
  document.
- `GET /{username}/{slug}` may return an HTML project page or redirect to the
  configured GeoLibre viewer. It is the `projectUrl` advertised by the API.

Every successful read of the latest raw document may increment `views`; servers
must not count failed or unauthorized reads.

### Thumbnails

`PUT /api/projects/{id}/thumbnail` requires ownership and accepts the image
bytes with their image content type. `GET /api/projects/{id}/thumbnail` follows
project visibility. `DELETE` removes it. Upload and delete responses are `204`.

## Compatibility

The API is additive within version 1. Implementations must not repurpose fields
or narrow visibility rules. New optional fields and endpoints may be added.
Breaking changes require a new `/api/v2` namespace. The conformance baseline is
the frontend tests for `share-geolibre.ts` and `share-gallery.ts`, plus the
reference server's API tests.
