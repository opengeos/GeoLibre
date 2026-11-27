# Offline Edit Sync

When you save edits to a remote source, GeoLibre does not send them straight
to the server and forget them. It first records them in a local **outbox**,
then syncs the outbox. If the source cannot be reached, the edits stay queued,
survive reloading the page or restarting the app, and sync on their own when
the connection returns. When they do, GeoLibre checks every feature against
what is on the server now, so an edit someone else made in the meantime is
never silently overwritten.

Sources that sync through the outbox:

| Source | How a conflict is detected |
| --- | --- |
| PostGIS tables (Add Data → PostgreSQL, editable mode) | Each row is compared with the row as you loaded it; the write is rejected if a row changes between the check and the write |
| ArcGIS feature services (writable feature layers) | Each feature's geometry and editable attributes are compared with the version you downloaded. Fields the service maintains (object and global IDs, editor tracking) are ignored, so a save that already landed is never mistaken for someone else's edit. A layer loaded with simplified shapes compares attributes only |
| GeoLens datasets (edited from the GeoLens panel) | Each feature is read back from the dataset and compared with the version you loaded. GeoLens has no transaction or version token, so a change made in the instant between that read and the write is not caught |

PostGIS layers loaded before the outbox existed keep the direct save for their
first save, then switch to the outbox from the next one.

Credentials never go into the outbox. A PostGIS change set finds its
connection among your saved connections when it syncs. An ArcGIS change set
syncs through its layer's own sign-in, so it waits while the project that
holds the layer is closed and syncs once the layer is open again. A GeoLens
change set syncs while the GeoLens panel is connected to that server with an
API key, and waits otherwise.

## Saving edits

Edit features the usual way (the attribute table, the Geo Editor, Field
Collection) and save with the layer's **Save edits to PostGIS table** or **Save
edits to ArcGIS service** action, with
**Project → Save layer edits to source files**, or (for GeoLens) with **Save**
in the GeoLens panel. GeoLibre works out what changed since the layer was
loaded (new, changed and deleted features) and only sends those features.

Saving again while edits are still queued replaces the queued version of every
feature the new save touches. If you undid a queued edit in the same session
(deleted a feature you drew, or put a value back), the new save drops it from
the queue. After a restart or reopening the project, GeoLibre cannot tell an
undone edit from one the reopened layer simply never had, so queued edits to
features the new save does not touch are kept until they sync or you discard
them in **Pending edits**.

For a PostGIS table, each sync attempt reads the whole table to compare rows,
plus once more to refresh the layer afterwards. That is cheap for typical
editable layers but grows with the table (editable layers are capped by
`GEOLIBRE_DB_MAX_FEATURES`, one million rows by default), so very large tables
are better edited through smaller views.

The save then reports one of four results:

- **Synced**: everything reached the source. The layer reloads from the source,
  so it shows generated keys and other people's new rows.
- **Queued**: the source could not be reached (no network, the database or the
  sidecar is down). The edits wait in the outbox and are retried automatically,
  sooner at first and then every few minutes, and immediately when the device
  comes back online.
- **Needs review**: some features were also changed on the source. Everything
  else was synced; the conflicting features wait for you to decide.
- **Failed**: the source refused the edits (for example a constraint, a
  domain, or a permission). An ArcGIS service can refuse single features while
  accepting the rest; only the refused ones stay queued. The edits stay in the outbox, with the source's message, until
  you sync again or discard them.

## The Pending edits indicator

While anything is queued, the status bar shows how many edits are waiting to
sync, or that some need review. Click it to open **Pending edits**, which lists
each queued source with the number of new, changed and deleted features, its
status, the last error, and when the next retry is due. From there you can:

- **Sync now** to retry right away instead of waiting for the next attempt.
- **Review conflicts** to resolve features that changed on both sides.
- **Discard** to drop the queued edits. The source keeps its current data; the
  open layer keeps your edits, so you can save them again later.

The outbox is stored in the app's own storage (IndexedDB in the browser, the
app data folder on desktop and mobile), separately from the project file. If
the browser refuses to keep data (some private windows), the dialog warns that
queued edits only last until the page is closed.

## Resolving conflicts

A conflict means a feature changed both in your copy and on the source since
you loaded it, or you edited a feature someone else deleted. For each one the
review shows the attributes that differ (yours next to the source's) and
whether the shape or position differs. Choose:

- **Keep mine** to write your version over the source's. Keeping your version
  of a feature the source deleted adds it again.
- **Keep source** to drop your change to that feature. The layer reloads with
  the source's version.
- **Decide later** to leave it queued. It does not block the other features.

**Keep all mine** and **Keep all from source** set every conflict at once.
**Apply and sync** sends your choices. The source is checked again at that
moment, so a feature that changed once more while you were deciding comes back
for review rather than being overwritten.

## How retries stay safe

Retrying a sync never applies an edit twice. Before writing, GeoLibre reads the
current version of every feature it is about to change: a feature that already
matches your version (because an earlier attempt landed before the connection
dropped) is counted as done, and a new feature whose earlier save may have
landed is matched against the source by its content before it is inserted
again.
