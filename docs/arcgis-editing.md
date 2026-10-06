# Editing ArcGIS Feature Services

GeoLibre can save feature additions, attribute and geometry updates, and deletions
back to an editable ArcGIS Feature Service in the web and desktop apps.

1. Choose **Add Data > ArcGIS Layer**, select **Feature layer**, and enter the
   service layer URL (or portal item). Supply an access token for a protected service.
2. Edit attributes in the attribute table or use **Layer actions > Edit geometry**.
   Finish the geometry editing session before saving.
3. Choose **Layer actions > Save edits to ArcGIS service**. The status reports
   inserted, updated, and deleted records, followed by any individual failures.

The save action appears when the service advertises supported editing operations
and supplies its field schema and object ID field. GeoLibre checks the latest
service metadata again before each save. The server remains responsible for
user permissions, ownership restrictions, attribute rules, and subtype constraints.
Write requests require HTTPS. Browser deployments also require the service to
permit cross-origin requests; desktop uses the native ArcGIS HTTP transport.

## Pending edits and refresh

GeoLibre retains a baseline of the features actually downloaded. Deletions are
limited to that baseline, including when the service was loaded with a feature
limit. Panning outside the downloaded extent never deletes server records.
Viewport loading and refresh pause while there are pending edits or an active
geometry editing session. They can resume once the edits are saved.

Only changed attributes are sent on updates. Successful inserts immediately
receive their server-assigned object IDs, and successful operations are removed
from the pending changes even if other operations fail. GeoLibre then queries
saved records for server defaults and calculated fields. Changes made locally
during a save remain pending.

A lost or incomplete response leaves the outcome uncertain. GeoLibre blocks
another save from that layer, including after reopening the project, to prevent
repeating an insert that may already have succeeded. Check the service state and
add the service as a new layer before continuing. Export pending local work first
if it needs to be retained. A confirmed service rejection can be corrected and retried.

Access tokens stay in the live connection and are not saved in the project.
Re-add protected services with a current token after reopening a project or when
an existing token expires.

## Signing in with ArcGIS

In Add Data, ArcGIS, set **Authentication** to **Sign in with ArcGIS** instead of
pasting a token. GeoLibre opens the portal's own sign-in page (OAuth 2.0
Authorization Code with PKCE), so it never sees your password, MFA code or
identity-provider credentials, and the layer is added with your own permissions.

1. Register an application on your portal (ArcGIS Online: Content, New item,
   Developer credentials; Enterprise: the same on your portal). Add GeoLibre's
   redirect URI to it: `<app URL>/oauth-callback.html` for the web app (for
   example `https://web.geolibre.app/oauth-callback.html`), and
   `org.geolibre.desktop:/oauth/callback` for the desktop app.
2. Leave **Portal URL** blank for ArcGIS Online, or enter your organization URL
   (`https://myorg.maps.arcgis.com`) to get its sign-in page, including SSO, or
   your Enterprise portal (`https://gis.example.org/portal`). If an Enterprise
   portal restricts allowed origins, add GeoLibre's.
3. Paste the application's client ID and select **Sign in**. The client ID is
   not a secret and is remembered per portal.

A build can ship a default ArcGIS Online client ID in the
`VITE_ARCGIS_OAUTH_CLIENT_ID` build variable; the hosted web app at
`web.geolibre.app` does, so its users can skip step 1. The field is prefilled
for ArcGIS Online and organization URLs only, and a client ID the user enters
replaces it. The default only works where its app registration lists that
build's redirect URI, so set it only for an origin you have registered.

The session is held in memory for the running app and shared by every ArcGIS
layer from the same portal. The access token (about 30 minutes) is renewed from
the refresh token, including for saving edits and refreshing layers. If it cannot
be renewed you are asked to sign in again. Select **Sign out** to end it and
revoke the refresh token. The session, tokens and sign-in choice are never saved
in the project or the service library, and manual access tokens remain available.
Vector tile, map service and image service layers carry the token they were
added with, which lasts about half an hour, so re-add them after that. The
session is not kept across app restarts yet.

To browse your portal's content instead of pasting service URLs, use
**Plugins → Web Services → ArcGIS Portal**, which shares this sign-in. See
[ArcGIS Portal](user-guide/web-services.md#arcgis-portal).

## Current scope

Supported geometry families are points, multipoints, lines, multilines, polygons,
and multipolygons. For Z-enabled services, 2D edits use the service's finite default Z only when
that default is explicitly enabled. Otherwise every vertex must supply a finite Z.
Object IDs must remain unchanged. New fields and changes to server-managed fields
cannot be written through feature editing. GeoLibre validates basic field types,
nullability, string lengths, and field-level coded-value and range domains.

Versioned services, M coordinates, dates in an unknown timezone, attachments,
related-record editing, and offline synchronization are outside this implementation.
There is no remote conflict-resolution protocol: if another client changes the
same attribute or geometry, the service decides which submitted edit is accepted.
Saving a project or exporting a layer does not itself write edits to the service.

The implementation uses Esri's [layer applyEdits API](https://developers.arcgis.com/rest/services-reference/enterprise/apply-edits-feature-service-layer/).
