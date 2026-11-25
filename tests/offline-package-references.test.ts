import assert from "node:assert/strict";
import { it } from "node:test";
import { referencesNativeOfflinePackage } from "../apps/geolibre-desktop/src/lib/offline-package-references";
import {
  nativeLocalPmtilesProtocolUrl,
  nativeMbtilesProtocolUrl,
} from "../apps/geolibre-desktop/src/lib/local-media-url";

const id = "pkg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const path = `/data/org.geolibre.app/offline-packages/${id}/archive.pmtiles`;

it("protects references by package identity without relying on a readable manifest", () => {
  for (const platform of ["android", "windows", "ios", "linux"] as const) {
    const url = `pmtiles://${nativeLocalPmtilesProtocolUrl(path, platform)}`;
    assert.equal(referencesNativeOfflinePackage({ source: { url }, metadata: {} }, id), true);
    const mbtiles = nativeMbtilesProtocolUrl(path.replace(".pmtiles", ".mbtiles"), platform);
    assert.equal(
      referencesNativeOfflinePackage({ source: { url: mbtiles }, metadata: {} }, id),
      true,
    );
  }
  assert.equal(
    referencesNativeOfflinePackage({ source: {}, sourcePath: path, metadata: {} }, id),
    true,
  );
  assert.equal(
    referencesNativeOfflinePackage({ source: {}, metadata: { nativeOfflinePackageId: id } }, id),
    true,
  );
  const windows = `C:\\Users\\user\\offline-packages\\${id}\\archive.pmtiles`;
  assert.equal(
    referencesNativeOfflinePackage({ source: {}, sourcePath: windows, metadata: {} }, id),
    true,
  );
});

it("does not mistake other packages or remote query parameters for owned package references", () => {
  for (const url of [
    `https://example.com/data?path=${encodeURIComponent(path)}`,
    `pmtiles://${nativeLocalPmtilesProtocolUrl(path.replace(id, "pkg-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"))}`,
    "pmtiles://http://local-pmtiles.localhost/file?path=%broken",
    "legacy.pmtiles",
  ])
    assert.equal(referencesNativeOfflinePackage({ source: { url }, metadata: {} }, id), false, url);
});
