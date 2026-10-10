# Editing ArcGIS Feature Services

GeoLibre can save feature additions, attribute and geometry updates, and deletions
back to an editable ArcGIS Feature Service in the web and desktop apps.

1. Choose **Add Data → ArcGIS Layer**, select **Feature layer**, and enter the
   service layer URL (or portal item). Supply an access token for a protected service.
2. Edit attributes in the attribute table or use **Layer actions → Edit geometry**.
   Finish the geometry editing session before saving.
3. Choose **Layer actions → Save edits to ArcGIS service**. The status reports
   inserted, updated, and deleted records, followed by any individual failures.

Edits stay local until step 3. The **Save** button of an Edit geometry session,
and **Save** in the attribute table, only commit the edits to the layer in
GeoLibre; the layer row then reminds you that they are not on the service yet.
After the service save, a new feature shows its service-assigned object ID and
any server-calculated fields such as area and length.

The save action appears when the service advertises supported editing operations
and supplies its field schema and object ID field. Versioned layers and layers
whose dates are in an unknown time zone are read-only. A layer that stores
measure (M) values, common for Enterprise polylines, accepts attribute edits and
deletions, but GeoLibre cannot author M values, so adding or reshaping its
features is refused at save. GeoLibre checks the latest
service metadata again before each save. The server remains responsible for
user permissions, ownership restrictions, and attribute rules.
Write requests require HTTPS. Browser deployments also require the service to
permit cross-origin requests; desktop uses the native ArcGIS HTTP transport.

## Domains, types and subtypes

GeoLibre reads the attribute domains the layer publishes in its own metadata
(no extra request) and applies them in the attribute table and before saving:

- A **coded-value domain** becomes a dropdown of the published names. The
  stored code keeps the field's declared type, so an integer field saves `1`
  and a text field saves `"1"`, `"01"` or `"0"` exactly. Read-only cells show
  the name, with the stored code in the tooltip. Exports and feature properties
  keep the codes.
- A **range domain** on an integer or floating-point field becomes a bounded
  number input. Bounds are inclusive and integer fields reject decimals.
- A numeric field **without a domain** edits as a number, so a value typed into
  a column that holds no values yet is still saved as a number.
- A **type or subtype field** (`typeIdField`/`types[]` or
  `subtypeField`/`subtypes[]`) becomes a dropdown of the published types.
  Fields whose domain the selected type overrides switch their choices and
  bounds as soon as the type changes, including before it is saved. A domain of
  `inherited`, or a field the type does not list, uses the field-level domain.

Changing a type never clears or replaces dependent values. A value that no
longer fits stays visible, is flagged, and must be corrected before the edit
can be saved. An edit that does not change the type only checks the fields it
changes, so existing records with historical values can still be edited.

A designer-authored Attributes Form on the layer is kept: its aliases, layout,
visibility rules and constraint expressions still apply, and its value map or
bounds may narrow the service's, but never widen them. A field the form hides
is still checked against the service domain.

Some metadata cannot be resolved with confidence. In each of these cases
GeoLibre leaves the check to the server and does not offer a constrained
editor for that field. Where the problem affects the whole layer, a notice
appears in the attribute table toolbar while editing:

- a domain referenced by name only, without its codes or range;
- `types[]` and `subtypes[]` that disagree about the same type, or name
  different fields (subtype-specific domains are then not applied);
- a type or subtype field that is not in the layer's field list;
- a record whose type code is not published, or a type that sets a field's
  domain to `null`.

Range domains on date fields and coded-value domains on date or GUID fields
keep the generic editor; the save check still validates them.

## New features

Features drawn with **Edit geometry** start with the service's creation
defaults, filling only attributes that are empty. Most specific first:

1. The type or subtype field takes the type of the only template the layer
   publishes, otherwise `defaultSubtypeCode`, otherwise the field's
   `defaultValue`.
2. Other editable fields take the prototype value of the template for that
   type, otherwise the subtype's `defaultValues`, otherwise the field's
   `defaultValue`.

A template is used only when the choice is unambiguous: the layer, or the
feature's type, publishes exactly one. With several templates none is picked,
and only subtype and field defaults apply. Change the type in the attribute
table afterwards if needed; defaults are not reapplied, and existing features
never receive them. Values the service assigns (object ID, global ID, editor
tracking and other read-only fields) are left to the server, which also fills
any field default GeoLibre did not, and the saved record is read back after
the save.

Copying or splitting a feature in the editor creates new features that keep
the copied attributes, minus the values the service assigns, so they save as
inserts. The original keeps its identity: the piece whose shape is unchanged,
or the first piece when a split changed them all.

An insert into an enterprise geodatabase runs as the database user the
service connects with, not as your ArcGIS account. If that user lacks the
database privilege to allocate object IDs, every insert fails with a message
such as `The EXECUTE permission was denied on the object 'i12_get_ids'`, from
GeoLibre, Map Viewer, or any other client, while updates and deletes still
succeed. GeoLibre marks this cause in the save status and keeps the new
features local. The data owner or DBA fixes it by granting the service's
database user its edit privileges on the feature class, including EXECUTE on
that procedure. Then save again.

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

## Attachments

Records in a layer that advertises attachments (`hasAttachments`) can carry
photos, PDFs, documents and other files stored by the service. Select one record
in the attribute table and choose the paperclip button to list its attachments
with their names, types and sizes.

- **Download** saves an attachment's original bytes under its stored name.
- **Preview** shows JPEG, PNG, GIF, WebP, BMP and AVIF images inline. Other
  types, including SVG, PDF and Office documents, are download-only, so no
  attachment content runs inside GeoLibre.
- **Add files** uploads one or more files, one request per file, each with its
  own result.
- **Replace** uploads new content for an attachment and keeps its ID.
- **Delete** asks for confirmation, then deletes that one attachment.

Attachment changes do not join the pending feature edits: each one saves to the
service immediately and the list is read back from the service afterwards. A
new feature gets attachments once **Save edits to ArcGIS service** has given it
an object ID. Attachments are addressed by layer, object ID and attachment ID,
never by file name, so duplicate names are safe. If an upload's response is
lost or the upload is cancelled in flight, GeoLibre reports the change as
unconfirmed. Refresh the list before retrying so the file is not added twice.

Adding needs the layer's Create or Update capability, and replacing or deleting
needs Update, matching Esri's attachment operations. Versioned layers and
MapServer layers list and download attachments only. The service still decides
for the signed-in user, and its file-type and size policy applies: a refused
file is reported with the service's message. The desktop app transfers at most
64 MiB per request. Attachments use the layer's connection, so signing in or a
token works the same as for feature edits, and no file, token or download URL is
saved in the project.

## Signing in with ArcGIS

In the **Add Data → ArcGIS Layer** dialog, set **Authentication** to **Sign in with ArcGIS** instead of
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
nullability, string lengths, and coded-value and range domains, including those
a type or subtype overrides.

Versioned services, M coordinates, dates in an unknown timezone,
related-record editing, and offline synchronization are outside this implementation.
Attachments of standalone tables, the bulk `queryAttachments` operation,
attachment keywords and upload IDs are not supported yet.
There is no remote conflict-resolution protocol: if another client changes the
same attribute or geometry, the service decides which submitted edit is accepted.
Saving a project or exporting a layer does not itself write edits to the service.

The implementation uses Esri's [layer applyEdits API](https://developers.arcgis.com/rest/services-reference/enterprise/apply-edits-feature-service-layer/)
and its attachment operations ([attachment infos](https://developers.arcgis.com/rest/services-reference/enterprise/attachment-infos-feature-service/),
[add](https://developers.arcgis.com/rest/services-reference/enterprise/add-attachment/),
[update](https://developers.arcgis.com/rest/services-reference/enterprise/update-attachment/) and
[delete](https://developers.arcgis.com/rest/services-reference/enterprise/delete-attachments/)).
