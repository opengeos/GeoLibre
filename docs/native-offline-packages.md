# Native offline basemap packages

**Offline basemap** extracts a bounding box and zoom range from a remote PMTiles
archive or, in the native app, a selected local MBTiles file. Choose the source,
draw an area or enter its bounds, and set the zoom range. Local MBTiles selection
initially fills the file's bounds and zooms. Extraction saves the result in private app storage
and records its name, extent, zooms, style, size, and SHA-256 checksum beside the
archive. It does not open an export or share dialog. The selected MBTiles file
stays unchanged. **Open file…** also keeps a
managed copy of a compatible Protomaps PMTiles basemap.

The **Saved basemaps** list can apply, rename, restyle, export, and delete these
packages. Export creates a separate document and leaves the managed package
available. Deleting a managed package removes its archive from this device and
can break offline maps in saved projects that reference it. Remove overlay
layers using a package before deleting it. Packages are never automatically
evicted when a layer or project closes.

Raster packages can be applied as basemap imagery. Protomaps-compatible vector
packages use the selected flavor; other vector MBTiles packages are added as
layers and can be restored with **Add package to map**. Vector MBTiles require
source-layer metadata. Saved package references and overlay layers can reopen
from native storage after restart.

MBTiles extracts contain only the selected zoom levels. Extraction and saved
application position the camera at or above the first stored zoom, so a
detail-only archive opens with visible tiles. Zooming below its available
pyramid can show an empty map; extraction does not generate overview tiles.

The native catalog survives browser-storage eviction. Startup restores native
file authorization and lightweight style registrations before opening a project.
Styled package addresses include both the package identity and flavor, so a
saved project can restore its own light or dark appearance. Native range reads
serve the PMTiles archive without loading the whole file back into JavaScript.
Vector MBTiles use a main-document protocol bridge to reach native storage on
Android, where direct worker requests cannot reach the URI handler. Only the
requested tile buffers cross into JavaScript, rather than the whole archive.
Protomaps glyphs and sprites are bundled with the app.

Legacy catalog entries for files exported by older versions remain available.
Deleting a legacy entry removes its catalog record, without deleting the
provider document. The browser build retains its download/file-picker workflow.

## Storage and limits

Packages live under the native app-data directory in `offline-packages/`.
Each published package has an immutable archive and a versioned manifest.
Writes use private staging directories, synced files, atomic directory rename,
and directory synchronization on Unix platforms. Windows syncs file contents;
directory flushing is not provided by the standard Rust filesystem interface.
The next storage operation recovers interrupted stages and deletions.
Locked staging files and deletion tombstones are retried on later operations
without hiding healthy packages from the inventory.
Once a deletion is durably recorded, a reader holding the file open may defer
physical cleanup. The next storage operation retries that cleanup while keeping
healthy packages available.

Inventory loading reports damaged entries without hiding healthy packages.
Explicit use verifies a package's checksum. A damaged package can be deleted
from the list and downloaded again. A failed catalog read reports an error
rather than replacing the native inventory with an empty browser catalog.

Remote PMTiles extraction still assembles the archive in memory. A managed archive is limited
to 512 MiB per save, and available device memory can impose a smaller practical
limit. Keep the selected area and zoom range small on mobile devices.
Explicit export uses the existing save/share workflow and buffers the archive
in the WebView; the range-read memory benefit applies to map rendering.
The raw native IPC transport temporarily holds both the request body and an
owned copy for the background write. On Android, the JSON transport fallback
also parses a numeric array before validating its length and decoding bytes;
the 512 MiB archive bound does not bound that parse's memory. Large archives
can therefore exhaust memory below the nominal limit.

Native catalog operations are serialized while an archive is written, synced,
or verified. The interface and map remain responsive, but inventory refreshes,
renames, and deletions wait for a running storage operation to finish. This
keeps recovery, manifest updates, verification, and deletion consistent.

Local MBTiles extraction stays in native storage and streams tile payloads into
a private SQLite output. It supports non-wrapping areas and zooms 0 through 30;
latitude is clipped to the Web Mercator tile matrix. Tile bytes are preserved,
and output rows are normalized to TMS. Each extraction accepts at most 200,000
tiles, 32 MiB per encoded tile, and 1 MiB of metadata across at most 1,024 rows.
The final SQLite archive must also fit the 512 MiB package limit. These bounds
and SQLite query/value limits do not constitute a whole-process memory cap.

Cancel interrupts native SQLite execution and checksum work before publication.
An already published package can still appear in the saved list after a late
cancel, but it is not applied to the canceled or replaced project. Up to eight
prepared or running native jobs are reserved; unused preparations expire after
60 seconds. A failed or canceled extraction cleans its staging directory.

The shared native storage implementation covers desktop, Android, and iOS;
real iOS device verification remains outstanding. Native MBTiles extraction is
available from this panel; browser MBTiles loading remains available through
Add data. Offline edit queues and
conflict-aware synchronization are also tracked in #3530.

While a managed package is being deleted, project loads, imports, and history
restores that would add an overlay reference to it fail before changing the
project. Unrelated project changes remain available. Retry the conflicting
operation after deletion settles.

Native extraction refuses plans estimated above 512 MiB before fetching tile
payloads, and the final byte length is checked again before binary IPC. Native
storage enforces the same limit. Deleting the live package switches to the
default basemap before file removal; a failed deletion leaves that fallback
selected and reports the error. A final validation failure after publication
can leave a package in the catalog even though the operation reports failure;
reopen the saved list to inspect and verify it before use.
Deleting a package also cancels its pending basemap application and prevents
reapplying it until deletion settles. An unrelated pending package application
keeps its request; a failed deletion allows a fresh apply attempt.
