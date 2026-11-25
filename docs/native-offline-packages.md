# Native offline basemap packages

**Offline basemap** extracts a bounding box and zoom range from a remote PMTiles
archive. In the native app, extraction saves the result in private app storage
and records its name, extent, zooms, style, size, and SHA-256 checksum beside the
archive. It does not open an export or share dialog. **Open file…** also keeps a
managed copy of a compatible Protomaps PMTiles basemap.

The **Saved basemaps** list can apply, rename, restyle, export, and delete these
packages. Export creates a separate document and leaves the managed package
available. Deleting a managed package removes its archive from this device and
can break offline maps in saved projects that reference it. Remove overlay
layers using a package before deleting it. Packages are never automatically
evicted when a layer or project closes.

The native catalog survives browser-storage eviction. Startup restores native
file authorization and lightweight style registrations before opening a project.
Styled package addresses include both the package identity and flavor, so a
saved project can restore its own light or dark appearance. Native range reads
serve the PMTiles archive without loading the whole file back into JavaScript.
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
Once a deletion is durably recorded, a reader holding the file open may defer
physical cleanup. The next storage operation retries that cleanup while keeping
healthy packages available.

Inventory loading reports damaged entries without hiding healthy packages.
Explicit use verifies a package's checksum. A damaged package can be deleted
from the list and downloaded again. A failed catalog read reports an error
rather than replacing the native inventory with an empty browser catalog.

Extraction still assembles the archive in memory. A managed archive is limited
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

The shared native storage implementation covers desktop, Android, and iOS;
real iOS device verification remains outstanding. Native MBTiles loading is
available through Add data, but MBTiles extraction and managed package import
from this panel remain separate follow-up work. Offline edit queues and
conflict-aware synchronization are also tracked in #3530.
