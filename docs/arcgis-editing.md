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
