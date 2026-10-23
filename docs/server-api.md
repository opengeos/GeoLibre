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
- Authenticated endpoints accept a personal API token or OAuth access token in
  `Authorization: Bearer <token>`.
- Error responses are JSON objects with an `error` string. `401` means a
  missing, invalid, or expired token; `403` means the authenticated principal
  lacks permission; `404` deliberately covers both a missing project and a
  project the caller may not discover; `409` is a uniqueness conflict; `422`
  is malformed input; and `429` is rate limiting.
- Public and unlisted raw project bodies (latest and versioned) use
  `Cache-Control: public, no-cache` with a strong `ETag`; `If-None-Match` with a
  matching tag returns `304`. Caches may store the body but must revalidate it on
  every use, so a visibility change takes effect at the next fetch.
  Responses containing private, organization, or group-protected content must
  use `Cache-Control: private, no-store`, including metadata listings.
- Cross-origin web deployments must allow `Authorization` and `Content-Type`
  from the GeoLibre web origin. On self-hosted Tauri installations using browser
  fetch, allow `tauri://localhost` and/or `http://tauri.localhost` explicitly.
  The shipped desktop HTTPS share origin uses native HTTP for authenticated
  requests; that transport does not depend on CORS.

## What the reference server leaves to the operator

Deployment protections remain the operator's responsibility:

- **Personal-token lifecycle.** Omitting `expiresInDays` preserves the v1
  delete-only lifecycle and creates a non-expiring token. Require an explicit
  1–365 day lifetime where bounded credentials are needed, and revoke or rotate
  delete-only and legacy tokens operationally.
- **Rate limiting.** The OAuth consent flow caps pending interactions per
  browser binding, but a fresh cookie bypasses that cap; the reference server
  has no general request limiter. Before enabling OAuth publicly, enforce
  per-client-IP limits at the ingress on **GET and POST** `/oauth/authorize`,
  `GET /oauth/sso/callback`, `POST /oauth/token`, `POST /api/auth/token`,
  `POST /api/accounts`, and `POST /api/account/password`. The last four POSTs
  include password or token operations; consent login and the PAT/account
  routes run scrypt, and the single sign-on callback calls the organization's
  identity provider. Add per-username limits where the
  ingress can safely parse credentials. Every public path to the API must go
  through this limiter: Compose binds the API host port to loopback by default.
  A root-issuer nginx deployment can put this zone in its `http` context and
  the location in its TLS issuer `server` context:

  ```nginx
  # http context
  limit_req_zone $binary_remote_addr zone=geolibre_auth:10m rate=12r/m;

  # TLS issuer server context; proxy other API routes separately.
  location ~ ^/(oauth/(authorize|token|sso/callback)|api/(auth/token|accounts|account/password))$ {
      limit_req zone=geolibre_auth burst=6 nodelay;
      limit_req_status 429;
      client_max_body_size 16k;
      access_log off;
      proxy_pass http://127.0.0.1:8000;
      proxy_set_header Host $http_host;
  }
  ```

  Preserve the original Host authority, including any port, or OAuth host
  binding rejects the request. Route the issuer's exact discovery URL and
  other API paths to the same backend; for a path-prefixed issuer, apply the
  limit to its externally visible prefix and strip that prefix when proxying.
  Suppress authorization request query strings, callback `Location` headers,
  and callback request query strings at the web ingress in proxy, WAF, and
  load-balancer logs.
- **A request-size limit.** The server rejects an oversized *declared*
  `Content-Length` before reading the body, but a chunked or HTTP/2 request
  declares no length and is parsed in full before the per-route limit applies.
  Cap request size at the proxy as well.

The reference implementation is a correctness baseline, not a hardened
deployment.

## Limits

| Field | Limit |
| --- | ---: |
| project title (derived from the uploaded project) | 100 Unicode code points |
| username | 3–39 lowercase ASCII letters, digits, or hyphens, not starting or ending with a hyphen |
| slug | 1–100 lowercase ASCII letters, digits, or hyphens |
| description | 2,000 Unicode code points |
| tags | 20 tags, 40 Unicode code points each |
| project document | 50 MiB UTF-8 JSON |
| thumbnail | 5 MiB; PNG, JPEG, or WebP |
| `limit` | default 24, maximum 100 |

Servers may configure a smaller upload limit, but must return `413` and an
`error` explaining that limit. The reference server reads its document and
thumbnail limits from `GEOLIBRE_MAX_PROJECT_BYTES` and
`GEOLIBRE_MAX_THUMBNAIL_BYTES`.

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

Creates an account and returns a personal API token once. This endpoint may be
disabled when an installation delegates identity to an external provider.
`name`, `scopes`, and `expiresInDays` are optional. New tokens default to all
three project scopes. Omitting `expiresInDays` preserves the v1 delete-only
token lifecycle (the token does not expire); the accepted explicit lifetime is
1–365 days. An unknown or empty `scopes` list returns `400`
`{"error": "invalid_scope"}`; an `expiresInDays` outside 1–365 returns `400`
`{"error": "invalid_request"}`. `email` is optional, trimmed and normalized to
lowercase, validated, and unique when present. A password shorter than 8
characters or a malformed username is `422`; a taken username or email is
`409`.

```json
{
  "username": "ada",
  "password": "correct horse battery staple",
  "email": "ada@example.org",
  "name": "GeoLibre desktop",
  "scopes": ["read:projects", "write:projects"],
  "expiresInDays": 30
}
```

Response `201`:

```json
{
  "account": {"id": "uuid", "username": "ada", "email": "ada@example.org", "createdAt": "2026-08-03T12:00:00Z"},
  "token": "secret-token",
  "tokenId": "uuid",
  "scopes": ["read:projects", "write:projects"],
  "expiresAt": "2026-09-02T12:00:00Z"
}
```

### `POST /api/auth/token`

Exchanges account credentials for a personal API token. It accepts the same
optional policy fields (but not `email`) and returns the same shape as account
creation. Tokens are opaque and stored only as SHA-256 digests.

| Status | `error` |
| --- | --- |
| 401 | `invalid username or password` |
| 401 | `account temporarily locked` (organization lockout policy) |
| 403 | `password expired` (change it with `POST /api/account/password`) |
| 403 | `single sign-on required` (an organization of the account [disallows built-in accounts](#organization-identity-provider)) |

### `GET /api/account` and `PATCH /api/account`

`GET /api/account` returns `{"account": <account>}` for any valid credential.

`PATCH` requires `write:projects`. `{"email":"ada@example.org"}` sets the signed-in
account's validated, normalized email; `{"email":null}` clears it. A duplicate
email is `409`. The response is `{"account": <account>}` and uses
`Cache-Control: private, no-store`.

### `DELETE /api/auth/token`

Revokes the presented Bearer token: a personal token is deleted, and an OAuth
access token revokes its whole session family. Response: `204`.

### `GET /api/users/me`

Returns the account, effective credential scopes, and OAuth session ID. `sessionId`
is `null` for personal tokens. A management grant reports only
`["manage:sessions"]`, not the project's scopes.

```json
{
  "user": {"id": "uuid", "username": "ada", "email": "ada@example.org", "createdAt": "2026-08-03T12:00:00Z"},
  "sessionId": "oauth-session-uuid",
  "scopes": ["read:projects", "write:projects", "share:public"]
}
```

An identity provider may create accounts without a username. Project creation
for such an account must return `400` with an error containing the stable,
case-insensitive sentinel text `username required`. Existing clients recognize
that phrase and direct the user to account settings.

### Session and personal-token management

These routes require a separate OAuth Bearer grant whose **only** scope is
`manage:sessions`. A project OAuth grant, even for the same account, and every
personal API token receive `403 insufficient_scope`. The client first resolves
the account ID and project `sessionId` using its project credential, then
requests fresh management consent and compares the management account ID
before listing anything. Management credentials must not be persisted or used
for project/gallery calls.

`GET /api/auth/sessions?limit=50&offset=0&currentSessionId=<project-session-id>`
returns `{"sessions": [<session>], "limit": 50, "offset": 0, "total": 1}`.
`limit` is 1–100; `offset` is nonnegative. If supplied, `currentSessionId`
must name an active project session owned by the management account, otherwise
the response is `404`. The server marks exactly that entry `current: true`.
Only active, unexpired project OAuth sessions and personal API tokens appear;
short-lived management grants never appear. Rows sort by creation time newest
first, then ID for ties. Each row contains a public UUID, not a token:

```json
{
  "id": "uuid",
  "kind": "oauth",
  "clientId": "geolibre-desktop",
  "label": "GeoLibre Desktop",
  "scopes": ["read:projects", "write:projects", "share:public"],
  "createdAt": "2026-08-03T12:00:00Z",
  "lastUsedAt": null,
  "expiresAt": "2026-09-02T12:00:00Z",
  "current": true,
  "legacy": false
}
```

Personal tokens use `kind: "personal-token"`, `clientId: null`,
`current: false`, and may have `expiresAt: null`. Old tokens without a policy
are backfilled on listing, marked `legacy: true`, and remain valid until
revoked. Management responses use `Cache-Control: private, no-store`.

`DELETE /api/auth/sessions/{id}` returns `204` for an owned project OAuth
family or personal token, including one already revoked. Management grants are
not addressable through this endpoint; unknown, foreign, and management-only IDs
return the same `404`. Revocation invalidates the family, not just one access
token.
If the ID is the current project session, the client must immediately clear
its local project credential and protected Gallery/remote-edit state; it must
not keep a stale session UI. A pasted personal token remains a separate
credential and is not silently replaced by the OAuth grant.

`POST /api/auth/sessions/revoke-others` accepts
`{"currentSessionId":"<project-session-id>"}` and returns `204`. It atomically
revokes every other OAuth family and **every** personal token for this account,
while keeping both the owned active project session named in the request and
the calling management grant. Missing, foreign, expired, revoked, or
management-only IDs are `404` without partial revocation. Clients should
confirm this destructive action and warn that scripts and CI using personal
tokens will stop working. Refresh rotation and bulk revocation serialize on
the session rows on PostgreSQL.

## Organizations

Organization and group routes use the same scopes as project routes: every
`GET` (memberships, members, invitations, galleries, a confined group's
thumbnail, and `GET /api/projects?shared_with_me=true`) requires
`read:projects`, and every mutation (creating organizations or groups, changing
settings or membership, issuing, revoking, or accepting invitations, joining,
deciding join requests, moderating, and thumbnails) requires `write:projects`.
Reading a non-public project reached through an organization or group, like a
private one, also requires `read:projects`.

`POST /api/organizations` creates an organization and makes the caller its first
`administrator`. The body contains `slug`, `name`, `publicSharingPolicy`
(`yes`, `publishers`, or `no`), `defaultVisibility`, and optional `categories`.
The slug is globally unique. When a project is created in the organization
without a `visibility`, the server applies `defaultVisibility`. A `public`
default requires `publicSharingPolicy` `yes`; creating or patching an
organization into any other combination returns `422`.

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

An administrator can also move a project *into* the organization with
`POST /api/projects/{id}/transfers` (`{"organizationId": "..."}`), which applies
immediately because the caller already manages the recipient (see
[Transfers](#transfers)).

Routes:

- `GET /api/organizations/mine` lists memberships and each caller's `role`.
- `GET /api/organizations/{id}` returns settings to a member.
- `PATCH /api/organizations/{id}` changes `name`, `publicSharingPolicy`,
  `defaultVisibility`, or `categories`; administrator only. Tightening
  `publicSharingPolicy` to `publishers` or `no` changes every `public`
  organization project whose creator could not publish it under the new policy
  (by their current role; creators no longer in the organization included) to
  `organization` visibility, and logs a `visibility_change` activity for each.
- `DELETE /api/organizations/{id}` deletes the organization, its
  organization-owned projects and their stored objects, its groups, members, and
  invitations; administrator only. Members' personal projects are kept. If any
  organization project is delete-protected, it refuses the entire deletion with
  `409` until that project's protection is turned off.
- `GET /api/organizations/{id}/members` lists members.
- `PUT /api/organizations/{id}/members` adds or updates
  `{"username":"ada","role":"member"}`; administrator only. Lowering a role
  re-applies the public sharing policy: `public` projects whose creator can no
  longer publish them become `organization`.
- `DELETE /api/organizations/{id}/members/{username}` removes a member
  (administrator only), and `{username}=me` leaves. The last administrator
  cannot be removed, leave, or be demoted (`409`). Neither can the break-glass
  administrator of the organization's identity provider (`422 account is the
  organization's break-glass administrator`); clear `breakGlassUsername` on the
  provider first. Projects the leaver created stay owned by the organization,
  and their `public` ones become `organization` unless the policy is `yes`. The
  leaver's memberships and pending invitations in the organization's groups
  are removed. Groups they own pass to the
  administrator who removed them; a member who owns one must transfer it before
  leaving (`409`).
- `POST /api/organizations/{id}/invitations` creates a pending invitation for
  exactly one `username` or `email`; `GET` on the same path lists pending,
  accepted, and revoked invitations. Issuance and listing are administrator
  only. The creation response alone includes the opaque `token`.
- `DELETE /api/organizations/{id}/invitations/{invitationId}` changes a pending
  invitation to `revoked`; administrator only.
- `POST /api/organizations/invitations/{token}/accept` requires sign-in, verifies
  the account's username or email, adds the member with the invited role, and
  changes the invitation to `accepted`.
- `GET /api/organizations/{id}/projects` returns the organization gallery. A
  non-administrator sees public and organization-visible projects plus private
  projects separately shared with one of their groups.

Supplying `organizationId` on project creation or patch transfers the project
to organization ownership. Its `username` is then `null`, every organization
administrator can manage it, and raw routes use
`/org/{organizationSlug}/{projectSlug}[.geolibre.json]`. Only an administrator
of the owning organization may change or clear `organizationId` on an
organization-owned project (`403` otherwise); clearing it returns the project to
its creator's individual account. A patch that changes `organizationId`
re-checks the project's group targets as a create in the new organization
would, whether they are sent in `groupIds` or kept from before; send `groupIds`
to replace targets that no longer qualify. The public sharing policy is enforced
on create and patch, including direct API requests.
Servers retain a nullable creator identity separately from ownership. New
projects record their creating account whether ownership is individual or
organizational; organization ownership remains authoritative, and the creator
identity does not populate `username` or create an individual project URL.

## Groups

`POST /api/groups` creates a standalone or organization-associated group. The
body contains `name`, optional `description` and `organizationId`, `joinPolicy`
(`invite`, `request`, or `open`), and `sharedUpdate`. An organization-associated
group admits only members of that organization: adding, inviting by username,
joining, accepting an invitation, or approving a request for anyone else returns
`403`. `sharedUpdate` is fixed at creation and cannot be patched; `name`,
`description`, and `joinPolicy` are settings. An optional PNG, JPEG, or WebP
thumbnail uses `PUT`/`GET`/`DELETE /api/groups/{id}/thumbnail`.

Group roles are `owner`, `manager`, and `member`. Exactly one accepted member is
the owner. An owner transfers ownership by assigning `owner` through
`PUT /api/groups/{id}/members`; the prior owner becomes a manager atomically.
Managers can add/remove ordinary members, invite, decide join requests, and
remove projects from the group. Only the owner can manage managers or transfer
ownership, and an owner cannot leave until ownership is transferred.

Routes:

- `GET /api/groups/mine` lists accepted memberships; `GET /api/groups/{id}`
  returns group detail to a signed-in caller. `PATCH /api/groups/{id}` changes
  `name`, `description`, or `joinPolicy`; owner or manager only.
- `DELETE /api/groups/{id}` deletes the group with its memberships,
  invitations, and thumbnail; owner only. Projects shared with the group are
  kept and lose only that group target.
- `GET /api/groups/{id}/members` lists accepted members. Owners/managers also
  see pending join requests.
- `PUT /api/groups/{id}/members` adds or changes a member using `username` and
  `role`; `DELETE /api/groups/{id}/members/{username}` removes one, and
  `{username}=me` leaves.
- `POST /api/groups/{id}/invitations` creates a pending invitation for exactly
  one `username` or `email`. The creation response includes its opaque token;
  manager listings (`GET` on the same path) omit the token and retain pending, accepted, and revoked
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
accepted member of every target. For an organization-owned project, a
non-administrator may target only that organization's groups. A member can read
a private project targeted to their group and can update its content only if
that group's immutable `sharedUpdate` value is true. Removing the membership or
target revokes access on the next request; protected raw and thumbnail responses
are never shared or persistently cached.

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

## Enterprise sign-in

### Organization security policy

Organization administrators can set a security policy for their members.

- `GET /api/organizations/{id}/security-policy` (`read:projects`) returns
  `{"securityPolicy": {...}}` with `idleTimeoutSeconds`,
  `absoluteSessionSeconds`, `adminReauthSeconds`, `adminIpAllowlist` (list),
  `passwordMinLength`, `passwordMinClasses`, `passwordMaxAgeDays`,
  `lockoutThreshold`, and `lockoutSeconds`. Unset values are `null`; with no
  policy every value is `null` and the allowlist is empty.
- `PUT /api/organizations/{id}/security-policy` (`write:projects`) replaces the
  whole policy (an omitted field becomes `null`) and returns the `GET` shape.

Both require an organization administrator and respond with
`Cache-Control: private, no-store`. Bounds:

| Field | Allowed |
| --- | --- |
| `idleTimeoutSeconds` | 300–2592000 |
| `absoluteSessionSeconds` | 900–31536000 |
| `adminReauthSeconds` | 60–86400 |
| `passwordMinLength` | 8–128 |
| `passwordMinClasses` | 1–4 (lowercase, uppercase, digits, symbols) |
| `passwordMaxAgeDays` | 1–3650 |
| `lockoutThreshold` | 3–100 |
| `lockoutSeconds` | 60–86400 |
| `adminIpAllowlist` | up to 50 IP addresses or CIDR networks |

Out-of-range values are a `422`. Other `422` errors:
`adminIpAllowlist entries must be IP addresses or networks`,
`lockoutThreshold and lockoutSeconds must be set together`, and
`adminIpAllowlist must include your current address` (so an administrator
cannot lock themselves out).

When an account belongs to several organizations, the strictest value wins:
the shortest idle timeout, absolute session lifetime, password age, and
lockout threshold; the longest minimum length, class count, and lockout
duration. Password length is never below 8.

- **Idle and absolute session limits** apply to OAuth sessions and personal
  tokens. An OAuth session idle longer than `idleTimeoutSeconds`, or older than
  `absoluteSessionSeconds` since its sign-in, is revoked: Bearer use returns
  `401 invalid or expired token` and refresh returns `400 invalid_grant`. A
  personal token is measured from its creation and last use and is revoked the
  same way. New OAuth families never outlive the absolute limit.
- **Lockout:** `lockoutThreshold` consecutive wrong passwords lock the account
  for `lockoutSeconds`; a successful sign-in resets the count.
- **Password rotation:** a password older than `passwordMaxAgeDays` is
  rejected at sign-in until changed with `POST /api/account/password`. For
  accounts created before this feature, the age counts from their first
  sign-in after the upgrade.
- **Administrator re-authentication:** when the organization sets
  `adminReauthSeconds`, administrator mutations (organization settings,
  members, invitations, security policy) from a credential whose sign-in is
  older than that return `401 {"error":"reauthentication_required"}` with
  `WWW-Authenticate: Bearer error="insufficient_user_authentication",
  max_age="<seconds>"` (RFC 9470). Sign in again to continue. Reads are not
  affected.
- **Administrator IP allowlist:** when `adminIpAllowlist` is non-empty, every
  administrator route of that organization from an address outside it returns
  `403 administrative access is not allowed from this network`. The client
  address is the direct peer unless the peer is listed in
  `GEOLIBRE_TRUSTED_PROXIES` (comma-separated IPs or CIDRs); then the
  rightmost untrusted `X-Forwarded-For` entry is used.

### `POST /api/account/password`

Unauthenticated. Body:
`{"username":"ada","currentPassword":"...","newPassword":"..."}` (new password
up to 1024 characters). Works even when the current password has expired.
Response: `204`.

| Status | `error` |
| --- | --- |
| 401 | `invalid username or password` |
| 401 | `account temporarily locked` |
| 403 | `single sign-on required` |
| 422 | `new password must differ from the current password` |
| 422 | `password must be at least <n> characters` |
| 422 | `password must use at least <n> of: lowercase, uppercase, digits, symbols` |

### Organization identity provider

An organization administrator can connect one OpenID Connect provider (Entra
ID, Okta, Google, Keycloak, ADFS 2016+, …) to the organization.

- `GET /api/organizations/{id}/identity-provider` (`read:projects`) returns
  `{"identityProvider": {...}}`, or `404 identity provider not configured`.
- `PUT /api/organizations/{id}/identity-provider` (`write:projects`) creates or
  replaces it and returns the `GET` shape.
- `DELETE /api/organizations/{id}/identity-provider` (`write:projects`)
  removes it. Response: `204`, also when none is configured.

All three require an organization administrator (the organization's IP
allowlist applies, and re-authentication applies to `PUT` and `DELETE`) and
respond with `Cache-Control: private, no-store`. `PUT` body:

```json
{
  "issuer": "https://login.example.org/realms/acme",
  "clientId": "geolibre",
  "clientSecret": "…",
  "tokenEndpointAuthMethod": "client_secret_basic",
  "scopes": ["openid", "email", "profile"],
  "usernameClaim": "preferred_username",
  "emailClaim": "email",
  "groupsClaim": "groups",
  "defaultRole": "member",
  "roleMappings": [{"value": "gis-admins", "role": "publisher"}],
  "groupMappings": [{"value": "gis-admins", "groupId": "group-uuid"}],
  "requireMfa": false,
  "allowBuiltinAccounts": true,
  "breakGlassUsername": null,
  "enabled": true
}
```

| Field | Rules |
| --- | --- |
| `issuer` | Required, up to 512 characters, `https://` without query or fragment. Compared exactly with the ID token's `iss`, never normalized. |
| `clientId` | Required, 1–255 characters. |
| `clientSecret` | 1–512 characters. Required when creating; omitted or `null` on update keeps the stored secret. Never returned. |
| `authorizationEndpoint`, `tokenEndpoint`, `jwksUri` | All three (each `https://`) or none. When none, they are read from the issuer's discovery document. |
| `tokenEndpointAuthMethod` | `client_secret_basic` (default) or `client_secret_post`. |
| `scopes` | Up to 20 simple scope tokens, including `openid`. Default `openid`, `email`, `profile`. |
| `usernameClaim`, `emailClaim`, `groupsClaim` | Claim names, up to 64 characters. Defaults `preferred_username`, `email`, `groups`; `groupsClaim` may be `null`. |
| `defaultRole` | Organization role when no role mapping matches. Default `member`. |
| `roleMappings` | Up to 100 `{"value", "role"}` entries. |
| `groupMappings` | Up to 100 `{"value", "groupId"}` entries; each group must belong to this organization. |
| `requireMfa` | Require `"mfa"` in the ID token's `amr`. Default `false`. Providers that list only the individual factors (for example `["pwd", "otp"]`) need a claim mapper that adds `"mfa"`, or every sign-in is rejected. |
| `allowBuiltinAccounts` | `false` disables password sign-in for the organization's members. Default `true`. |
| `breakGlassUsername` | A current administrator of this organization who keeps password sign-in. Required when `allowBuiltinAccounts` is `false`. |
| `enabled` | A disabled provider is neither offered nor accepted. Default `true`. |

The `GET` shape echoes the settings (`scopes` as a list) plus `protocol`
(`"oidc"`), the stored endpoints, `clientSecretSet: true` instead of the
secret, `redirectUri`, and `updatedAt`. Register `redirectUri`
(`<issuer>/oauth/sso/callback` of this server; `null` when OAuth is not
configured) at the identity provider for a confidential client using the
authorization code flow with S256 PKCE.

`422` errors: `issuer must be an https URL without query or fragment`,
`clientSecret is required`, `set all three endpoints or none`,
`identity provider endpoints must be https URLs`,
`scopes must include openid and use simple scope tokens`,
`group mapping must name a group in this organization`,
`break-glass account must be an organization administrator`,
`a break-glass administrator is required when built-in accounts are disallowed`,
and `identity provider discovery failed`. Out-of-range values are a generic
`422`.

- **Discovery:** without explicit endpoints, `PUT` fetches
  `<issuer>/.well-known/openid-configuration`. Its `issuer` must equal the
  configured `issuer` exactly and it must name `https://` authorization, token,
  and JWKS endpoints; a network error, non-`200` status, a body over 1 MiB, or
  invalid JSON also fails discovery. The endpoints are stored; discovery runs
  again only on the next `PUT`. Signing keys are fetched from `jwksUri` on the
  first sign-in and cached; changing `issuer` or `jwksUri` clears the cache.
  Once the provider has linked federated identities, `PUT` cannot change its
  `issuer` or `jwksUri`; it returns `409 issuer or JWKS endpoint cannot change
  while federated identities are linked`. This prevents a replacement authority
  from reusing `sub` values to resolve existing accounts. Account migration or
  re-linking is not automatic; do not delete and recreate the provider as a
  workaround, since deletion removes the identity links.
  A sign-in validated against old settings is rejected if those settings changed
  before identity linking; `PUT` and sign-in serialize on the provider row in
  PostgreSQL. A `PUT` racing provider removal or replacement returns HTTP 409
  with message `identity provider was removed or replaced; try again`.

- **Internal addresses (SSRF protection):** any signed-in user can create an
  organization and choose its provider URLs, so the server connects to an
  identity provider only on public addresses. Each host is resolved once and
  every loopback, private, link-local, CGNAT (`100.64.0.0/10`), multicast,
  reserved, or unspecified address (including their IPv4-mapped, NAT64, 6to4,
  and Teredo forms) is dropped; a host left with none fails like a network
  error, so discovery answers `identity provider discovery failed` and sign-in
  is rejected. The connection goes to the checked address, while TLS still
  verifies the certificate against the URL's hostname. To use a provider on an
  internal network, list its networks in `GEOLIBRE_OIDC_ALLOWED_NETWORKS`
  (comma-separated IPs or CIDRs; an invalid entry fails startup).
- **Accounts:** the first sign-in of a provider subject (`sub`) creates an
  account linked to it. Its username comes from `usernameClaim` (or else
  `emailClaim`): lowercased, cut at `@`, other characters replaced with `-`,
  with a `-2`…`-99` suffix when taken. When nothing fits, the account has no
  username (see the `username required` sentinel under `GET /api/users/me`). Its
  email is set only when `email_verified` is `true` and no other account uses
  the address. A sign-in is never linked to an existing account by email, so
  existing members who move to single sign-on get a new account. Federated
  accounts have no password.
- **Mappings,** applied at every sign-in from the `groupsClaim` value (a string
  or a list of strings): the role is the highest-ranked `role` among matching
  `roleMappings`, else `defaultRole`. A new member receives it; an existing
  member's role follows it only when `roleMappings` is non-empty, and neither
  the organization's last administrator nor its break-glass administrator is
  ever demoted. A lowered role re-applies the public sharing policy as
  `PUT /api/organizations/{id}/members` does: `public` projects the member can
  no longer publish become `organization`. For each mapped group,
  the account becomes a `member` when a matching value is present and loses a
  plain `member` row when none is; owner and manager rows are never changed.
- **Built-in accounts:** with `allowBuiltinAccounts: false`, a correct password
  for any member of the organization other than the break-glass administrator
  is rejected: `403 single sign-on required` from `POST /api/auth/token` and
  `POST /api/account/password`, and `Your organization requires single
  sign-on. Use “Sign in with your organization”.` on the consent page. The
  break-glass account keeps password sign-in only while it remains an
  administrator of the organization; lockout still applies to it. While it is
  the break-glass account it cannot be demoted, removed, or leave (`422`);
  clear `breakGlassUsername` first.
- **Deletion** removes the provider, its account links, and pending sign-in
  redirects. Accounts and memberships remain, but accounts created through
  single sign-on have no way to sign in. A provider configured later links
  subjects afresh, so their next sign-in creates new accounts; remove the old
  ones.
- **Secret storage:** `clientSecret` is stored unencrypted in the database, at
  the same trust level as the rest of its contents.

### Single sign-on on the consent page

When any organization has an enabled identity provider, the consent page adds
a second form: an `Organization` field (the organization slug) and a
`Sign in with your organization` button (`decision=sso`, with the same
`interaction`, `csrf`, and `label` fields). Its `POST` answers `303` to that
organization's authorization endpoint with `state`, `nonce`, an S256 PKCE
challenge, and `max_age` when the organization's security policy sets
`adminReauthSeconds`. An unknown slug or a disabled provider re-renders the
consent page with `Single sign-on is not configured for that organization`.
Browsers apply `form-action` to that redirect, so while single sign-on is
offered the consent page's `Content-Security-Policy` adds `https:` to
`form-action`.

`GET /oauth/sso/callback` receives the provider's response. The `state` must
be live and unused, the interaction undecided and unexpired, and the request
must carry the browser-binding cookie of the browser that started consent.

- `error` from the provider: `303` to the client's callback with
  `error=access_denied`.
- Otherwise the server redeems the `code` at the token endpoint with the client
  secret and PKCE verifier and validates the ID token: an RS256, PS256, or
  ES256 signature from the provider's JWKS (an unknown key id refetches the
  key set at most once a minute), `iss`, `aud` (plus `azp` when there are
  several audiences), `exp` and `iat` with 60 seconds of leeway, `nonce`,
  `sub`, `amr` when `requireMfa` is set, and `auth_time` when `max_age` was
  sent. Success approves the interaction exactly like a password sign-in: `303`
  to the client's callback with `code`, `state`, and `iss`. The OAuth session's
  sign-in time is the ID token's `auth_time` when present.
- Any other failure, including a reused `state`, returns a `400` page with
  `invalid_request: single sign-on response rejected`. The reason is only
  logged (`oidc sign-in rejected: <reason>`).

Calls to the identity provider give up when connecting or any read stalls for
10 seconds, or once the whole response has taken longer than 10 seconds. They
never follow redirects, ignore proxy environment variables, and stop reading at
1 MiB. Set `GEOLIBRE_OIDC_CA_BUNDLE` to also trust a provider whose
certificate is issued by a private CA; the public CAs stay trusted.

### Trusted-header proxy sign-in

With `GEOLIBRE_PROXY_AUTH=true` (or `1`/`yes`), behind an identity-aware proxy
listed in `GEOLIBRE_TRUSTED_PROXIES`, the consent page trusts the proxy's user
header (`GEOLIBRE_PROXY_USER_HEADER`, default `Remote-User`) and optional email
header (`GEOLIBRE_PROXY_EMAIL_HEADER`, default `Remote-Email`). Without
`GEOLIBRE_PROXY_AUTH`, `GEOLIBRE_TRUSTED_PROXIES` only trusts
`X-Forwarded-For` and identity headers are never read. When the direct peer is
a trusted proxy and the user header is present, the page shows `Signed in
through your organization's proxy as <user>` instead of the password and
single sign-on forms, and `Allow` approves the interaction for the account
linked to that user. The first sign-in creates the account: the username is
derived as for single sign-on, and the email is set when it is valid and
unused. Organization mappings and the built-in account switch do not apply to
proxy identities. An empty user, one over 255 characters, or one containing
control characters returns a `400` page with `invalid_request: invalid proxy
identity`; an account that cannot be created returns `invalid_request: proxy
sign-in failed`. Identity headers from any other peer are never read, so the
proxy must strip client-sent identity headers and be the only network path to
the API.

### SCIM 2.0

An organization's identity provider can provision its users and groups with
SCIM 2.0 (RFC 7643/7644). An organization administrator mints a token for it:

- `POST /api/organizations/{id}/scim-tokens` (`write:projects`), body
  `{"label": "Entra ID"}` (1–100 characters), returns `201`
  `{"token": "...", "scimToken": {...}, "baseUrl": "<public URL>/scim/v2/<organization id>"}`.
  The raw token is shown only here; the server stores its digest.
- `GET /api/organizations/{id}/scim-tokens` (`read:projects`) returns
  `{"scimTokens": [...]}`, newest first.
- `DELETE /api/organizations/{id}/scim-tokens/{tokenId}` (`write:projects`)
  revokes the token. Response: `204`; an unknown token, or one of another
  organization, is `404 SCIM token not found`.

A token object is `{"id", "label", "createdAt", "lastUsedAt", "revokedAt"}`
(`lastUsedAt` is updated at most once a minute). The routes require an
organization administrator (with the organization's IP allowlist, and
re-authentication for `POST` and `DELETE`) and respond with
`Cache-Control: private, no-store`.

Configure the identity provider with `baseUrl` as the tenant/SCIM URL and the
token as a Bearer secret. Every SCIM request needs
`Authorization: Bearer <token>` for that organization; a missing, revoked, or
other organization's token is `401` with `WWW-Authenticate: Bearer`. Tokens
also stop working when their creator is deactivated or ceases to be an active
organization administrator. SCIM requests are machine-to-machine, so the
organization's administrator IP allowlist and re-authentication window do not
apply to them; revoke a token to cut off a provider.

Request bodies are `application/scim+json` (or `application/json`); responses
are `application/scim+json`. Errors use the SCIM error message:
`{"schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"], "status": "409", "detail": "userName already exists", "scimType": "uniqueness"}`.

| Endpoint | Notes |
| --- | --- |
| `GET /ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` | Discovery. PATCH and filtering are supported (up to 100 results); bulk, sort, ETags, and password changes are not. |
| `GET /Users` | `startIndex` (default 1) and `count` (0–100, default 100), ordered by creation. `filter` only `userName eq "…"` (case-insensitive) or `externalId eq "…"`; anything else is `400 invalidFilter`. |
| `POST /Users` | Creates an account, or adopts the existing SSO account when this organization's enabled identity provider has a unique matching lowercased username claim or verified email claim. Password accounts, proxy identities, accounts managed by another organization, and ambiguous matches are not adopted. `userName` (1–255 characters, stored lowercased) is required and unique per organization (`409 uniqueness`). |
| `GET`/`PUT`/`PATCH`/`DELETE /Users/{id}` | `id` is the account id. `PUT` replaces `userName`, `externalId`, `displayName`, `emails`, and (when present) `active`. |
| `GET /Groups` | `filter` only `displayName eq "…"` (case-insensitive) or `externalId eq "…"`. |
| `POST /Groups` | Creates an organization group owned by the token's creator, with `join_policy` `invite`. Every member must be a user provisioned in this organization (`400 invalidValue`). |
| `GET`/`PUT`/`PATCH`/`DELETE /Groups/{id}` | `PUT` replaces `displayName`, `externalId`, and the member set. `DELETE` deletes the group. |

A user resource carries `id`, `userName`, `externalId`, `displayName`,
`active`, `emails` (the primary address only), and `meta`. Other attributes are
accepted and ignored. A provisioned account has no password and no email
address of its own: `emails` is kept for the SCIM representation only. Its
username is derived from `userName` the way single sign-on derives it, and it
joins the organization with the identity provider's `defaultRole` (`member`
without a provider). A group resource's `members` lists only plain accepted
members; the owner and managers are never listed or changed by SCIM. Only users
and groups created through SCIM are visible to it (`404 resource not found`
otherwise).

SCIM identity claims are refreshed on every OIDC sign-in. An email claim is
eligible for matching only when the provider asserts `email_verified: true`.
When a previously signed-in account has no SCIM resource and a matching SCIM
resource belongs to an unused SCIM-created account, the next sign-in reconciles
the SCIM resource onto the real account, transfers only member-role entries in
this organization's SCIM groups (without duplicates), then deactivates the
orphan and removes its organization membership and group-member rows. The
orphan account record is retained. A deactivated SCIM resource remains
deactivated after reconciliation.

Deleting a managed SCIM user deactivates the account and revokes its OAuth and
personal-token credentials, but retains its federated identity. Reprovisioning
the same username adopts that deactivated account and reactivates it without
restoring old credentials; an authorization code approved before deactivation
cannot be exchanged afterward.

**PATCH** bodies need the `urn:ietf:params:scim:api:messages:2.0:PatchOp`
schema and an `Operations` list (else `400 invalidSyntax`). `op` is
case-insensitive. For users, `add` and `replace` accept the paths `active`,
`userName`, `externalId`, `displayName`, `emails`, and
`emails[type eq "work"].value`, or no path with an object of attributes;
unknown paths are ignored. `remove` accepts only `externalId` and
`displayName`. Other operations are `400 unsupported patch operation`
(`invalidSyntax`). For groups, `add` takes `members` (a list of
`{"value": "<user id>"}`), `displayName`, or `externalId`; `remove` takes
`members[value eq "<user id>"]`, `members` with a value list (or no value to
remove every member), or `externalId`; `replace` takes `displayName`,
`externalId`, `members`, or no path with an object of those. A successful
PATCH returns `200` with the resource.

**Entra ID:** `active` may be the strings `"True"`/`"False"`, operation names
may be capitalized (`Replace`), and Entra's extra attribute paths are ignored,
so its default attribute mappings work unchanged. Entra soft-deletes by
setting `active` to `false`, and later sends `DELETE`.

**Deactivation.** Setting `active` to `false` (`PUT` or `PATCH`), or
`DELETE`, depends on who manages the account:

- An account this organization manages (created by its SCIM or its single
  sign-on) is deactivated: every OAuth session and personal token is revoked in
  the same transaction, Bearer use returns `401 invalid or expired token`,
  refresh returns `400 invalid_grant`, password sign-in fails as an invalid
  password, single sign-on returns a `403` page with
  `This account has been deactivated.`, and trusted-proxy sign-in shows the
  same message on the consent page.
- Any other account only loses its membership in this organization and its
  membership (except group ownership) in the organization's groups; the account
  itself and its other organizations are untouched. Access ends on the next
  request because authorization reads memberships live. Its SCIM `active` reads
  `false` while it is not a member.
- Setting `active` back to `true` reactivates a managed account and re-adds the
  organization membership if missing. Credentials revoked by the deactivation
  stay revoked; the user signs in again.
- `DELETE /Users/{id}` deactivates as above, removes the organization and group
  memberships, and forgets the SCIM user. Removing the organization's only
  administrator, by deactivation of an account it does not manage or by
  `DELETE`, is `409 cannot remove the last organization administrator`
  (`mutability`); removing the identity provider's break-glass account is
  `409 cannot remove the organization's break-glass administrator`
  (`mutability`). Clear `breakGlassUsername` on the provider first.
- Removing a membership applies the organization's public sharing policy the
  same way leaving through the members API does: the removed account's public
  organization projects become organization-only unless the policy is `yes`.

**Single sign-on link:** the first single sign-on of a subject in an
organization with SCIM users links to the provisioned account whose `userName`
equals the ID token's `usernameClaim` (lowercased), or failing that its
`emailClaim`, instead of creating a new account. Provision `userName` as the
value the provider puts in that claim (for Entra ID, the UPN in
`preferred_username`).

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
  "deleteProtected": false,
  "role": "edit",
  "expiresAt": null,
  "hasPassword": false,
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

`deleteProtected` is the owner's per-project "prevent deletion" switch. It is
`false` by default and present in every project representation, anonymous ones
included. While it is `true`, `DELETE /api/projects/{id}` is refused (see
below).

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
title is authoritative. `visibility` is optional and is `public`, `unlisted`,
`private`, or `organization`. `organizationId` is required when `visibility`
is `organization`. `groupIds` is an optional array of group identifiers; the
caller must be a member of every listed group, and for an organization project
a non-administrator may list only that organization's groups. When `visibility`
is omitted, the organization's `defaultVisibility` applies, or `private` for a
personal project.

Optional share-link settings (only for `public` or `unlisted` projects; any other
visibility answers `422` when one is set): `role` (`view`, `comment`, or `edit`; default
`edit`), `expiresIn` (`24h`, `7d`, `30d`, or `never`), and `password`. They are
echoed in every project representation as `role`, `expiresAt` (ISO timestamp or
`null`), and `hasPassword`. `role` is metadata for viewers; the server enforces
only the expiry and the password. Once `expiresAt` has passed, anyone but a
manager of the project gets `410` (`share link expired`) from every read route.
While a password is set, those readers get `401` (`share password required`)
until they unlock the link with `POST /{username}/{slug}/access` (or
`POST /org/{organization}/{slug}/access` for an organization project) with
`{"password": "..."}`. That returns `{"content": "<project JSON>", "role": "view"}`
with `Cache-Control: private, no-store`. After 10 wrong passwords within 5 minutes
from one client address, the route answers `429` for that project, even for the
right password. The count is kept in memory, per server process.

The version-list route (`GET /api/projects/{id}/versions`) takes no password, so
while a password is set it answers `401` to everyone except a manager of the
project.

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

Requires ownership, or organization administrator / active organization creator access for organization-owned projects. Accepted fields are `title`, `description`, `visibility`,
`tags`, `organizationId`, `groupIds`, and `deleteProtected`. Response: `{"project": <project>}`.
An explicit `null` for `visibility`, `organizationId`, or `deleteProtected`
where the field is non-nullable is refused with `422` rather than failing at
commit.

### `PUT /api/projects/{id}/content`

Requires ownership, organization administrator or active organization creator
access for organization-owned projects, or membership in a targeted
shared-update group. Creates a new immutable version.

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
When the project's `deleteProtected` is `true`, the request is refused with
`409` and `{"error": "project is delete-protected; turn off deleteProtected
before deleting it"}`. The phrase `delete-protected` is stable: clients match
on it to explain the refusal. Turning the switch off with
`PATCH /api/projects/{id}` `{"deleteProtected": false}` unblocks the delete.

Deleting a project also removes its pending transfers and its redirect rows.

### `GET /api/shares`

Requires `read:projects`. Returns `{"shares": [<project>, ...]}`, newest-updated
first: the projects the caller manages whose `visibility` is `public` or `unlisted`
(organization-visible projects are not link shares). Each
entry is a project representation plus `projectSlug`. A share's `id` is its
project id. Expired links stay listed so they can be revoked.

### `DELETE /api/shares/{id}`

Requires `write:projects` and management of the project. Revokes the share: the
project becomes `private` and its `role`, expiry, and password are reset. The
project, its versions, and its group shares are kept. Response: `204`; `403` when
the caller does not manage the project; `404` when the project is unknown, already
private, or organization-visible.

### `GET /api/projects/{id}/activity`

Requires ownership. Returns the project's activity log, newest first, capped
at 100 entries:

```json
{"activity": [
  {"id": "…", "action": "visibility_change", "actorId": "…",
   "details": {"before": "private", "after": "public"}, "createdAt": "…"},
  {"id": "…", "action": "open", "actorId": null,
   "details": {"date": "2026-08-21", "count": 40}, "createdAt": "…"}
]}
```

Actions and their `details`: `version_save` (`version`), `fork`
(`forked_project_id`), `visibility_change` (`before`, `after`), `transfer`
(`from`, `to` — `"org:<slug>"` or a username), `fetch` of
the raw JSON (`version`) and `open` of the project page. `actorId` is the
acting account, or `null` for an anonymous visitor. Anonymous `open` and
`fetch` events are **never stored per visitor**: they are aggregated into one
row per action and UTC day carrying a `count`, and no IP address or other
visitor fingerprint is recorded. Rows are pruned after
`GEOLIBRE_ACTIVITY_RETENTION_DAYS` (default 90) the next time the project logs
an event. The log is visible only to the owner and never appears in listings.

### `DELETE /api/projects/{id}/activity`

Requires ownership. Deletes every activity row for the project. Response: `204`.

### `POST /api/projects/{id}/forks`

Requires auth. Creates a new project owned by the caller from the visible
source's latest content. The request body is **optional**: `{"visibility": ...}`
selects the fork's visibility, and omitting the body entirely (the common "fork
this project" call) must behave as `{"visibility":"private"}` rather than
returning `422`. Responds `201` with `{"project": <project>}`. The source
`forkCount` increases atomically. A fork of an organization project that is not
`public` or `unlisted` stays owned by that organization, so the caller's role
and the organization's public sharing policy apply to it exactly as on create.

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

When a project was moved by a transfer, the address it vacated answers `301
Moved Permanently` to the project's new raw JSON (for the `.geolibre.json`
route) or new page URL (for the page route). The redirect is followed only when
the caller can already see the target project, so a private or
organization-only project's new address is not disclosed to others: an
anonymous request to a vacated private address is `404`, not `301`.
Authorized redirects to private or organization-only projects use
`Cache-Control: private, no-store` so the old path cannot retain a previously
authorized destination after sign-out. Public and unlisted redirects use
`Cache-Control: public, no-cache` so a later transfer or visibility change
revalidates the destination.

### Transfers

A project can be handed to another user, who must accept, or to an organization
the caller administers, which applies immediately. The project keeps its `id`,
`views`, `forkCount`, version history, and activity; only its namespace and
slug change. Every transfer clears the project's group shares (they were grants
to the previous audience) and records a permanent redirect for the address it
vacates.

`POST /api/projects/{id}/transfers` requires ownership, or administrator
membership for an organization-owned project, plus `write:projects`. An active
organization creator who is not an administrator cannot transfer its property
out. The body takes exactly one of `username` or `organizationId`, and an
optional `slug`:

```json
{"username": "bob", "slug": "wetlands"}
```

- A **user** target creates a `pending` transfer. Nothing moves until that user
  accepts, so the project keeps its current owner and address in the meantime.
  Responds `201` with `{"transfer": <transfer>, "project": <project>}`.
- An **organization** target requires that the caller administers the
  organization and is applied immediately (the transfer is stored as
  `accepted`). It responds `201` with `{"transfer": <transfer>, "project":
  <project>}`, the project already moved.

Refusals use stable phrases so clients can explain them:

| Status | `error` | Cause |
| --- | --- | --- |
| `409` | `slug already exists for the new owner` | The destination namespace already uses the requested slug; retry with another `slug`. |
| `409` | `a transfer is already pending for this project` | One pending transfer per project. |
| `404` | `user not found` | No account has that username. |
| `422` | `provide exactly one of username or organizationId` | Both or neither target was given. |
| `422` | `project already belongs to that owner` | The destination is already the owner. |

Receiving and managing:

- `GET /api/transfers/incoming` lists the caller's pending offers, newest
  first: `{"transfers": [...]}`.
- `GET /api/transfers/outgoing` lists the pending transfers the caller started:
  `{"transfers": [...]}`.
- `POST /api/transfers/{id}/accept` (recipient only) moves the project. Its body
  is optional: `{"slug": "..."}` overrides the destination slug, which is how a
  recipient resolves a slug conflict (`409 slug already exists for the new
  owner`). Responds `200` with `{"project": <project>, "transfer": <transfer>}`.
  If the initiator no longer manages the project, or another request resolved
  the offer first, the response is `409 transfer is no longer valid`.
- `POST /api/transfers/{id}/decline` (recipient only) responds `204`.
- `DELETE /api/transfers/{id}` cancels a pending transfer (the initiator, or
  anyone who can still manage the project) and responds `204`.

A transfer can change visibility: a project that was `public` becomes
`organization` when it moves into an organization whose `publicSharingPolicy`
is not `yes`, and a project that was `organization` becomes `private` when it
moves to an individual. Both changes are recorded as `visibility_change`
activity.

A vacated `<username>/<slug>` (or `/org/<slug>/<slug>`) address stays
**reserved** while its redirect exists: a later upload of the same title in that
namespace receives a `-2` suffix rather than taking over the old link.

Both listing routes use `Cache-Control: private, no-store`.

A transfer is returned as:

```json
{
  "id": "uuid",
  "projectId": "uuid",
  "projectTitle": "Wetlands",
  "projectSlug": "wetlands",
  "fromUsername": "ada",
  "toUsername": "bob",
  "toOrganization": null,
  "slug": "wetlands",
  "status": "pending",
  "createdAt": "2026-09-30T12:00:00Z",
  "resolvedAt": null
}
```

`toUsername` is `null` for an organization transfer, where `toOrganization` is
`{"id", "slug", "name"}` instead. `status` is `pending`, `accepted`, `declined`,
or `cancelled`. `projectSlug` is the project's slug *at the time of the
response*; `slug` is the slug it will take at its destination.

### Thumbnails

`PUT /api/projects/{id}/thumbnail` requires ownership and accepts the image
bytes with their image content type. `GET /api/projects/{id}/thumbnail` follows
project visibility. `DELETE` removes it. Upload and delete responses are `204`.

## Personal token scopes

| Scope | Grants |
| --- | --- |
| `read:projects` | List and open the caller's own projects, including unlisted/private projects; read organization/group memberships, galleries, and projects shared with the caller |
| `write:projects` | Create, update, delete, and fork projects the caller may manage or shared-update; create and manage organizations, groups, memberships, and invitations; change the account email |
| `share:public` | Create a public project or raise a project's visibility to public |

New personal tokens require a nonempty subset of these scopes. Omitting
`scopes` preserves the historical project permissions for existing clients.
Omitting `expiresInDays` keeps the token valid until revoked (the v1
delete-only lifecycle); set `expiresInDays` to 1–365 to mint an expiring token.
Tokens that predate the policy table are upgraded on first use with all three
project scopes, no expiry, and a legacy marker.

A valid credential missing a required scope receives `403` with
`{"error": "insufficient_scope", "requiredScope": "<scope>"}` and
`WWW-Authenticate: Bearer error="insufficient_scope"`. Missing credentials use
the `Bearer` challenge; malformed, unknown, revoked, and expired credentials use
`Bearer error="invalid_token"`.

## OAuth 2.0 sign-in (Authorization Code + S256 PKCE)

The reference server implements Authorization Code with PKCE (`S256` only) for
public clients; no client secret is accepted. Registrations are exact and
startup-validated through `GEOLIBRE_OAUTH_CLIENTS`. The only supported client
IDs are `geolibre-web` and `geolibre-desktop`. Empty or unset configuration
disables every OAuth route without changing personal-token startup behavior.

The issuer is `GEOLIBRE_PUBLIC_URL`. When OAuth is enabled it must be an
absolute HTTPS URL. Loopback HTTP is allowed only for `localhost` or
`127.0.0.1` with an explicit port. The request `Host` header, including its
port, must match the issuer authority.

### Discovery

`GET /.well-known/oauth-authorization-server` returns RFC 8414 metadata. For an
issuer with path `/services/projects`, the route is
`/.well-known/oauth-authorization-server/services/projects`. The document
advertises the authorization, token, and revocation endpoints; authorization
code and refresh grants; `S256`; the three project scopes; and
`manage:sessions` (OAuth-only).

### Authorization and consent

`GET /oauth/authorize` accepts one value each for `response_type=code`,
`client_id`, exact `redirect_uri`, nonempty `scope`, `state`, `code_challenge`,
and `code_challenge_method=S256`; `device_label` is optional. State is 16–512
URL-safe characters. The S256 challenge is the 43-character unpadded base64url
SHA-256 value.

Duplicate authorization parameters, unknown clients, unregistered redirects,
and state values longer than 512 characters return a local error page without
a `Location` header. Other authorization errors redirect to the already
validated callback with `error`, `iss`, and the exact `state` value when supplied.

`POST /oauth/authorize` submits the server-owned consent form. It requires the
browser-binding cookie, CSRF value, same-origin `Origin` or `Referer`, and
account credentials. Approval returns `303` to the exact callback with a
single-use code, `state`, and `iss`; cancellation returns `access_denied`.
Authorization codes expire after 60 seconds by default
(`GEOLIBRE_OAUTH_CODE_TTL_SECONDS`).
Production HTTPS uses a host-only `Secure` browser-binding cookie; permitted
loopback HTTP development uses a host-only non-`Secure` cookie so Safari can
submit the consent form.

Web redirects must be absolute HTTPS URLs ending in `/oauth-callback.html`.
Explicit-port loopback HTTP is allowed for development. Desktop redirects must
be exactly `org.geolibre.desktop:/oauth/callback`. The installed Tauri desktop
app opens consent in the system browser and receives that URI through the OS
protocol handler (on macOS, Windows, and Linux), not an inbound HTTP listener.
It accepts a callback only for a live, matching state and issuer. A callback
that cold-launches an app with no pending verifier cannot complete sign-in:
the user must restart consent. No authorization code or token belongs in a
diagnostic log or a persisted project.

### Token exchange and rotation

`POST /oauth/token` accepts form-urlencoded bodies up to 16 KiB:

- `grant_type=authorization_code` requires `client_id`, `code`,
  `redirect_uri`, and a 43–128 character `code_verifier`.
- `grant_type=refresh_token` requires `client_id` and `refresh_token`.
  Optional `scope` must be the same scope set as the original grant; ordering
  does not matter.

Success returns:

```json
{
  "access_token": "opaque",
  "token_type": "Bearer",
  "expires_in": 600,
  "refresh_token": "opaque",
  "scope": "read:projects write:projects"
}
```

Request `manage:sessions` **alone** for a fresh step-up consent. Combining it
with project scopes is `invalid_scope`. Its success response has
`"scope":"manage:sessions"` and `"expires_in":300` (or less if the server
enforces a shorter access lifetime), but **no `refresh_token`**. The server
never creates a refresh row for this grant, rejects refresh attempts, and
caps its access token and family at five minutes. A client must hold the
management token only in memory and discard it when session management closes,
the project session changes, or the grant expires. A `401` on a management
request requires a new consent; it must not sign the project session out.

Access tokens expire after 600 seconds by default
(`GEOLIBRE_OAUTH_ACCESS_TTL_SECONDS`) and never outlive their family. Refresh tokens are single-use and rotate on every use. Reusing a
consumed refresh token revokes the entire family, including tokens minted by
the successful rotation. A family expires at issuance plus the configured
refresh TTL (`GEOLIBRE_OAUTH_REFRESH_TTL_SECONDS`, 30 days by default);
rotation never extends it.

An enabled server deletes bounded batches of expired interactions, access
tokens, and families at startup, during OAuth requests, and every five minutes
while running. Consumed refresh generations stay until the family expires so
replay detection remains effective.

`POST /oauth/revoke` accepts `client_id`, `token`, and optional advisory
`token_type_hint`. A matching access or refresh token revokes its entire
family. Unknown, already-revoked, and wrong-client tokens all return the same
empty `200`.

OAuth failures use `invalid_request`, `invalid_client`, `invalid_grant`,
`invalid_scope`, `unsupported_grant_type`, or `unsupported_token_type`. Token
and revocation responses are `no-store`. Raw codes and tokens are returned once;
the database stores only SHA-256 digests.

Project OAuth access tokens use the same project scope matrix as personal
tokens. `manage:sessions` authorizes only the session-management routes
documented above. It is exclusive to OAuth consent, never available to
personal tokens; it grants no project read or write access. `admin:org`
remains reserved and is rejected.

## Compatibility

The API is additive within version 1. Implementations must not repurpose fields
or narrow visibility rules. New optional fields and endpoints may be added.
Breaking changes require a new `/api/v2` namespace. The conformance baseline is
the frontend tests for `share-geolibre.ts` and `share-gallery.ts`, plus the
reference server's API tests.
