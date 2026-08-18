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
  public/unlisted project versions and may use `ETag`/conditional requests.
  Responses containing private, organization, or group-protected content must
  use `Cache-Control: private, no-store`, including metadata listings.
- CORS deployments must allow `Authorization` and `Content-Type` from the
  GeoLibre web origin. Native desktop requests do not depend on CORS.

## What the reference server leaves to the operator

Three parts of the contract above are deliberately not implemented in
`backend/geolibre_server_api`, and an operator exposing it publicly has to
supply them:

- **Rate limiting.** `429` is in the error vocabulary, but no route returns it.
  `POST /api/auth/token` and `POST /api/accounts` are unauthenticated and run
  scrypt on every call, so without a limiter in front they allow password
  brute-forcing, username enumeration through the `409`/`401` distinction, and
  a cheap CPU-burn. Put a reverse proxy or WAF limit on both, keyed by client IP
  and by username.
- **Token expiry.** `401` covers an expired token, but tokens issued here do not
  carry an expiry and stay valid until `DELETE /api/auth/token` revokes them.
- **A request-size limit.** The server rejects an oversized *declared*
  `Content-Length` before reading the body, but a chunked or HTTP/2 request
  declares no length and is parsed in full before the per-route limit applies.
  Cap request size at the proxy as well.

All three are contract-level capabilities a compatible server may implement;
the reference implementation is a correctness baseline, not a hardened
deployment.

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
- `private`: an individually owned project is readable only by its owner unless
  explicitly shared with a group. An organization-owned private project is
  readable by organization administrators and by its creator while that creator
  remains an administrator, publisher, or member. Other organization members
  and viewers need an explicit group share. Raw and thumbnail URLs require the
  same Bearer token as the metadata endpoint.
- `organization`: readable by every signed-in member of the owning organization.
  It is omitted from public listings and its raw/thumbnail responses are always
  `Cache-Control: private, no-store` so removing a member revokes a known URL
  immediately after their client revalidates it.

Changing visibility affects every version immediately. A raw URL is therefore
not a capability URL for a private project.

## Identity

### `POST /api/accounts`

Creates an account and returns a token once. This endpoint may be disabled when
an installation delegates identity to an external provider.

```json
{
  "username": "ada",
  "password": "correct horse battery staple",
  "email": "ada@example.org"
}
```

Response `201`:

```json
{
  "account": {"id": "uuid", "username": "ada", "email": "ada@example.org", "createdAt": "2026-08-03T12:00:00Z"},
  "token": "secret-token"
}
```

### `POST /api/auth/token`

Exchanges account credentials for a personal API token.

```json
{"username": "ada", "password": "correct horse battery staple"}
```

Response `200` has the same shape as account creation. Tokens are opaque and
must be stored hashed by the server. `email` is optional at account creation,
trimmed and normalized to lowercase, validated, and unique when present.

### `PATCH /api/account`

Requires auth. `{"email":"ada@example.org"}` sets the signed-in account's
validated, normalized email; `{"email":null}` clears it. A duplicate email is
`409`. The response is `{"account": <account>}` and uses
`Cache-Control: private, no-store`.

### `DELETE /api/auth/token`

Revokes the presented Bearer token. Response: `204`.

### `GET /api/users/me`

Returns the account associated with the token:

```json
{"user": {"id": "uuid", "username": "ada", "email": "ada@example.org", "createdAt": "2026-08-03T12:00:00Z"}}
```

An identity provider may create accounts without a username. Project creation
for such an account must return `400` with an error containing the stable,
case-insensitive sentinel text `username required`. Existing clients recognize
that phrase and direct the user to account settings.

## Organizations

`POST /api/organizations` creates an organization and makes the caller its first
`administrator`. The body contains `slug`, `name`, `publicSharingPolicy`
(`yes`, `publishers`, or `no`), `defaultVisibility`, and optional `categories`.
The slug is globally unique. `defaultVisibility` is returned as the safe client
default; requests still state their visibility explicitly.

Organization roles are:

- `administrator`: manage settings and membership, and mutate any
  organization-owned project.
- `publisher`: create organization content and publish publicly when policy is
  `publishers` or `yes`.
- `member`: create organization content and share within the organization; may
  publish only when policy is `yes`.
- `viewer`: read organization-visible content only.

A publisher or member who creates organization content may manage that content
while they retain that organization role. Administrators may manage every
organization project. Demotion to viewer or removal from the organization
immediately removes the creator's management permission; the project remains
owned by the organization rather than becoming orphaned.

The same rule governs private reads: administrators and active creators can
read private organization projects they can manage. Membership alone does not
grant a publisher, member, or viewer access to somebody else's private project.

Routes:

- `GET /api/organizations/mine` lists memberships and each caller's `role`.
- `GET /api/organizations/{id}` returns settings to a member.
- `PATCH /api/organizations/{id}` changes `name`, `publicSharingPolicy`,
  `defaultVisibility`, or `categories`; administrator only.
- `GET /api/organizations/{id}/members` lists members.
- `PUT /api/organizations/{id}/members` adds or updates
  `{"username":"ada","role":"member"}`; administrator only.
- `DELETE /api/organizations/{id}/members/{username}` removes a member. The
  last administrator cannot be removed or demoted.
- `POST /api/organizations/{id}/invitations` creates a pending invitation for
  exactly one `username` or `email`; `GET` on the same path lists pending,
  accepted, and revoked invitations. Issuance and listing are administrator
  only. The creation response alone includes the opaque `token`.
- `DELETE /api/organizations/{id}/invitations/{invitationId}` changes a pending
  invitation to `revoked`; administrator only.
  `POST /api/organizations/invitations/{token}/accept` requires sign-in, verifies
  the account's username or email, adds the member with the invited role, and
  changes the invitation to `accepted`.
- `GET /api/organizations/{id}/projects` returns the organization gallery. A
  non-administrator sees public and organization-visible projects plus private
  projects separately shared with one of their groups.

Supplying `organizationId` on project creation or patch transfers the project
to organization ownership. Its `username` is then `null`, every organization
administrator can manage it, and raw routes use
`/org/{organizationSlug}/{projectSlug}[.geolibre.json]`. Clearing
`organizationId` transfers it to the caller's individual account. The public
sharing policy is enforced on create and patch, including direct API requests.
Servers retain a nullable creator identity separately from ownership. New
projects record their creating account whether ownership is individual or
organizational; organization ownership remains authoritative, and the creator
identity does not populate `username` or create an individual project URL.

## Groups

`POST /api/groups` creates a standalone or organization-associated group. The
body contains `name`, optional `description` and `organizationId`, `joinPolicy`
(`invite`, `request`, or `open`), and `sharedUpdate`. `sharedUpdate` is fixed at
creation and cannot be patched; `name`, `description`, and `joinPolicy` are
settings. An optional PNG, JPEG, or WebP thumbnail uses
`PUT`/`GET`/`DELETE /api/groups/{id}/thumbnail`.

Group roles are `owner`, `manager`, and `member`. Exactly one accepted member is
the owner. An owner transfers ownership by assigning `owner` through
`PUT /api/groups/{id}/members`; the prior owner becomes a manager atomically.
Managers can add/remove ordinary members, invite, decide join requests, and
remove projects from the group. Only the owner can manage managers or transfer
ownership, and an owner cannot leave until ownership is transferred.

Routes:

- `GET /api/groups/mine` lists accepted memberships; `GET /api/groups/{id}`
  returns group detail to a signed-in caller.
- `GET /api/groups/{id}/members` lists accepted members. Owners/managers also
  see pending join requests.
- `PUT /api/groups/{id}/members` adds or changes a member using `username` and
  `role`; `DELETE /api/groups/{id}/members/{username}` removes one, and
  `{username}=me` leaves.
- `POST /api/groups/{id}/invitations` creates a pending invitation for exactly
  one `username` or `email`. The creation response includes its opaque token;
  manager listings omit the token and retain pending, accepted, and revoked
  rows. `DELETE .../invitations/{invitationId}` changes a pending invitation to
  `revoked`, and `POST /api/groups/invitations/{token}/accept` changes it to
  `accepted` while adding the signed-in target account.
- `POST /api/groups/{id}/join` immediately joins an open group, creates a
  pending request for a request group, and rejects an invite-only group.
  `POST /api/groups/{id}/members/{username}/decide` with decision `accept` or
  `reject` moderates a pending request.
- `GET /api/groups/{id}/projects` lists targeted projects.
  `DELETE /api/groups/{id}/projects/{projectId}` removes that target without
  deleting the project.

Project create and patch requests accept `groupIds`. The caller must be an
accepted member of every target. A member can read a private project targeted
to their group and can update its content only if that group's immutable
`sharedUpdate` value is true. Removing the membership or target revokes access
on the next request; protected raw and thumbnail responses are never shared or
persistently cached.

Invitation tokens are bearer credentials. For both organization and group
invitations, servers must store only a SHA-256 digest, return the raw token only
from the creation call, and hash the path token before acceptance lookup.
Accepted and revoked tokens cannot be reused.

Group thumbnails follow the group's join policy. An `open` group's thumbnail is
public and may use `Cache-Control: public, max-age=3600`. For `invite` and
`request` groups, only accepted members may fetch the thumbnail and every
successful response uses `Cache-Control: private, no-store`; non-members receive
`404`. This prevents a stable public thumbnail URL from disclosing content from
a membership-confined group.

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
  "canEdit": true,
  "organization": {"id": "uuid", "slug": "watershed-lab", "name": "Watershed Lab"},
  "groupIds": ["group-uuid"],
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

`organization` is non-null whenever the project is organization-owned,
regardless of visibility.
`groupIds` is an array of group identifiers the project is shared with (empty
array when none). Authenticated project, listing, create, and update responses
include `canEdit`, computed by the server for that caller. It is true for an
individual owner, an organization administrator, an active organization
creator, or a member of a targeted group whose `sharedUpdate` setting is true.
Clients must use this value instead of reconstructing authorization from roles.
Anonymous responses omit it. Because authenticated public responses vary by
caller, they use `Cache-Control: private, no-store`. Unknown fields must be
ignored by consumers.

### `POST /api/projects`

Requires auth. Creates a project and its first immutable version.

```json
{
  "filename": "Wetlands.geolibre.json",
  "content": "{\"version\":\"1.0\", ...}",
  "visibility": "public",
  "organizationId": "org-uuid",
  "groupIds": ["group-uuid-1", "group-uuid-2"]
}
```

`content` is a string containing a valid GeoLibre project JSON document.
`filename` supplies a fallback title/slug; the project document's non-empty
title is authoritative. `visibility` is required and is `public`, `unlisted`,
`private`, or `organization`. `organizationId` is required when `visibility`
is `organization`. `groupIds` is an optional array of group identifiers; the
caller must be a member of every listed group.

### `GET /api/projects`

Returns a page in newest-updated-first order:

```json
{"projects": [], "limit": 24, "offset": 0, "total": 0}
```

Query parameters:

- `limit`: integer page size.
- `offset`: non-negative number of matching records to skip.
- `featured=true`: return featured projects only.
- `mine=true`: return the caller's own projects, including unlisted and private
  ones. Requires auth; without a valid token this is `401`.
- `shared_with_me=true`: return organization-visible projects from the caller's
  organizations, organization public projects, manageable private/unlisted
  organization projects, and projects explicitly targeted to their groups.
  Requires auth and cannot be combined with `mine=true`.
- `shared_source=organizations|groups`: with `shared_with_me=true`, restrict the
  query before pagination and counting. `organizations` includes public and
  organization-visible projects in the caller's organizations plus
  private/unlisted projects manageable as an administrator or active creator.
  `groups` includes projects explicitly targeted to an accepted group
  membership. Using this parameter without `shared_with_me=true` is `422`.

Only public projects are returned unless `mine=true` or `shared_with_me=true` is
set. An Authorization header does not broaden a public listing by itself.
Invalid pagination or combining both private listing modes is `422`.

### `GET /api/users/{username}/projects`

Returns `{"projects": [...]}` owned by `{username}`, in newest-updated-first
order. Auth is optional and decides the breadth of the result: when the token
identifies `{username}`, the listing includes their unlisted and private
projects; every other caller, authenticated or not, sees only that user's public
projects. The current client first resolves its username through
`GET /api/users/me`, then calls this route.

The route accepts `limit` (1-100, default 24) and `offset` (default 0).

A non-owner therefore gets a filtered `200`, not a `403` — the listing narrows
rather than refusing, which keeps a user's existence from being probed through
the status code.

### `GET /api/projects/{id}`

Returns `{"project": <project>}` if visible to the caller.

### `GET /api/projects/{id}/versions`

Requires auth and read access to the project. Returns newest first:

```json
{"versions":[{"number":3,"createdAt":"2026-08-03T12:00:00Z","url":"https://example.org/api/projects/uuid/versions/3"}]}
```

Protected project history responses use `Cache-Control: private, no-store`.
The existing `GET /api/projects/{id}/versions/{version}` route continues to
return the immutable project document itself.

### `PATCH /api/projects/{id}`

Requires ownership. Accepted fields are `title`, `description`, `visibility`,
`tags`, `organizationId`, and `groupIds`. Response: `{"project": <project>}`.

### `PUT /api/projects/{id}/content`

Requires ownership or write access via a shared-update group. Creates a new
immutable version.

```json
{"content": "{\"version\":\"1.0\", ...}", "expectedVersion": 3}
```

`expectedVersion` is optional. When provided and it does not match the current
latest version, the write still succeeds under last-write-wins and the `201`
response includes a `warning` string containing the stable phrase
`version conflict`. A matching or omitted version has no `warning` field.

Response `201`: `{"project": <project>, "version": <positive integer>}`.

### `DELETE /api/projects/{id}`

Requires ownership. Deletes metadata and stored objects. Response: `204`.

### `POST /api/projects/{id}/forks`

Requires auth. Creates a new project owned by the caller from the visible
source's latest content. The request body is **optional**: `{"visibility": ...}`
selects the fork's visibility, and omitting the body entirely (the common "fork
this project" call) must behave as `{"visibility":"private"}` rather than
returning `422`. Responds `201` with `{"project": <project>}`. The source
`forkCount` increases atomically.

### Raw project and website-compatible routes

- `GET /{username}/{slug}.geolibre.json` returns the latest project document
  with `Content-Type: application/json`.
- `GET /api/projects/{id}/versions/{version}` returns an immutable historical
  document.
- `GET /{username}/{slug}` may return an HTML project page or redirect to the
  configured GeoLibre viewer. It is the `projectUrl` advertised by the API.
- Organization-owned equivalents are
  `GET /org/{organizationSlug}/{slug}.geolibre.json` and
  `GET /org/{organizationSlug}/{slug}`.

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
