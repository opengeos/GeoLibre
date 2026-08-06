import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  DRIVE_FOLDER_MIME_TYPE,
  SHAPEFILE_SIDECAR_EXTENSIONS,
  driveErrorCode,
  driveFolderChildrenUrl,
  driveMediaUrl,
  driveMetadataUrl,
  drivePickerBlocker,
  drivePublicDownloadUrl,
  fileNameFromContentDisposition,
  groupFolderVectorFiles,
  isWorkspaceDocument,
  parseDriveTarget,
  pickerOutcome,
  type DriveFile,
} from "../apps/geolibre-desktop/src/lib/google-drive";
import { canQueryDriveApi } from "../apps/geolibre-desktop/src/lib/google-drive-client";

describe("parseDriveTarget", () => {
  it("reads the id from every link shape Drive hands out", () => {
    // The ids below are made up and intentionally not resolvable: this is pure
    // string parsing, so nothing here is ever fetched. Pinning the cases to a
    // real Drive file would make the suite depend on someone's sharing settings
    // staying put, for no extra coverage.
    const cases: [string, string, "file" | "folder"][] = [
      [
        "https://drive.google.com/file/d/1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUvW/view?usp=sharing",
        "1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUvW",
        "file",
      ],
      [
        "https://drive.google.com/open?id=1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUvW",
        "1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUvW",
        "file",
      ],
      [
        "https://drive.google.com/uc?export=download&id=1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUvW",
        "1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUvW",
        "file",
      ],
      [
        "https://drive.usercontent.google.com/download?id=1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUvW&export=download",
        "1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUvW",
        "file",
      ],
      [
        "https://drive.google.com/drive/folders/1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUvW?usp=drive_link",
        "1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUvW",
        "folder",
      ],
      [
        "https://drive.google.com/drive/u/0/folders/1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUvW",
        "1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUvW",
        "folder",
      ],
    ];
    for (const [input, id, kind] of cases) {
      assert.deepEqual(parseDriveTarget(input), { id, kind }, input);
    }
  });

  it("accepts a bare id, which is what people paste when they copy from a URL", () => {
    assert.deepEqual(parseDriveTarget("  1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUvW  "), {
      id: "1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUvW",
      kind: "file",
    });
  });

  it("prefers the folder rule so a folder link is never read as a file", () => {
    const target = parseDriveTarget("https://drive.google.com/drive/folders/1AAAAAAAAAAAAAAA");
    assert.equal(target?.kind, "folder");
  });

  it("rejects text with nothing id-shaped in it", () => {
    for (const input of ["", "   ", "https://example.com/data.zip", "shapefile.zip", "d/edit"]) {
      assert.equal(parseDriveTarget(input), null, input);
    }
  });
});

describe("Drive request URLs", () => {
  it("sends an API key in the query but never an access token", () => {
    const withKey = new URL(driveMetadataUrl("FILE_ID", { apiKey: "AIzaKEY" }));
    assert.equal(withKey.searchParams.get("key"), "AIzaKEY");

    // A token authenticates through the Authorization header (added by the
    // client), so putting it in the URL would leak it into logs for no gain.
    const withToken = new URL(driveMetadataUrl("FILE_ID", { accessToken: "ya29.TOKEN" }));
    assert.equal(withToken.searchParams.get("key"), null);
    assert.ok(!withToken.href.includes("ya29.TOKEN"));
  });

  it("asks for the fields the download depends on", () => {
    // The name is what the import pipeline classifies the format on, so losing
    // it from the field mask would break every add, not just an edge case.
    const url = new URL(driveMetadataUrl("FILE_ID", { apiKey: "K" }));
    const fields = url.searchParams.get("fields") ?? "";
    for (const field of ["id", "name", "mimeType", "size"]) {
      assert.ok(fields.split(",").includes(field), `fields is missing ${field}`);
    }
  });

  it("requests the media, not the metadata, for a download", () => {
    const url = new URL(driveMediaUrl("FILE_ID", {}));
    assert.equal(url.searchParams.get("alt"), "media");
    assert.ok(url.pathname.endsWith("/FILE_ID"));
  });

  it("scopes a folder listing to the folder and excludes trashed items", () => {
    const url = new URL(driveFolderChildrenUrl("FOLDER_ID", { apiKey: "K" }, "PAGE2"));
    assert.equal(url.searchParams.get("q"), "'FOLDER_ID' in parents and trashed = false");
    assert.equal(url.searchParams.get("pageToken"), "PAGE2");
    assert.equal(url.searchParams.get("includeItemsFromAllDrives"), "true");
  });

  it("confirms the virus-scan interstitial on the public download host", () => {
    // Without confirm=t Drive answers a large file with an HTML warning page in
    // place of the bytes, which fails deep in the loader as a parse error.
    const url = new URL(drivePublicDownloadUrl("FILE_ID"));
    assert.equal(url.searchParams.get("confirm"), "t");
    assert.equal(url.searchParams.get("id"), "FILE_ID");
  });
});

describe("isWorkspaceDocument", () => {
  it("flags Google-native documents, which have no bytes to download", () => {
    assert.equal(isWorkspaceDocument("application/vnd.google-apps.spreadsheet"), true);
    assert.equal(isWorkspaceDocument("application/vnd.google-apps.document"), true);
  });

  it("does not flag a folder, which the caller handles rather than rejects", () => {
    assert.equal(isWorkspaceDocument(DRIVE_FOLDER_MIME_TYPE), false);
  });

  it("does not flag ordinary binary files", () => {
    assert.equal(isWorkspaceDocument("application/zip"), false);
    assert.equal(isWorkspaceDocument("application/octet-stream"), false);
  });
});

describe("fileNameFromContentDisposition", () => {
  it("prefers the RFC 5987 form, which is how Drive sends non-ASCII names", () => {
    const header =
      "attachment; filename=\"________.zip\"; filename*=UTF-8''%E0%B8%82%E0%B8%AD%E0%B8%9A%E0%B9%80%E0%B8%82%E0%B8%95.zip";
    assert.equal(fileNameFromContentDisposition(header), "ขอบเขต.zip");
  });

  it("falls back to the plain parameter", () => {
    assert.equal(
      fileNameFromContentDisposition('attachment; filename="provinces.zip"'),
      "provinces.zip",
    );
  });

  it("returns null when there is no header or no name in it", () => {
    assert.equal(fileNameFromContentDisposition(null), null);
    assert.equal(fileNameFromContentDisposition("attachment"), null);
  });
});

describe("driveErrorCode", () => {
  it("separates a rejected credential from a file that is simply not shared", () => {
    // Different fixes: 401 means re-enter the key or sign in again, 403 means
    // change the file's sharing. Collapsing them would send users to the wrong
    // one for the case they hit most.
    assert.equal(driveErrorCode(401), "unauthorized");
    assert.equal(driveErrorCode(403), "forbidden");
    assert.equal(driveErrorCode(404), "notFound");
    assert.equal(driveErrorCode(500), "requestFailed");
  });
});

describe("DriveErrorCode i18n keys", () => {
  // The dialog resolves these with a runtime-interpolated key,
  // `t(`addData.googleDrive.error.${err.code}`)`, which neither TypeScript nor
  // i18next's typed `t` can check. A code added without a catalog entry would
  // render the raw key at runtime, so read the union out of the source and
  // require en.json to cover all of it.
  const source = readFileSync(
    fileURLToPath(new URL("../apps/geolibre-desktop/src/lib/google-drive.ts", import.meta.url)),
    "utf8",
  );
  const union = /export type DriveErrorCode =([\s\S]*?);/.exec(source);
  assert.ok(union, "could not find the DriveErrorCode union in google-drive.ts");
  const codes = [...union[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);

  const en = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../apps/geolibre-desktop/src/i18n/locales/en.json", import.meta.url)),
      "utf8",
    ),
  ) as { addData: { googleDrive: { error: Record<string, string> } } };

  it("found the codes to check", () => {
    assert.ok(codes.length >= 7, `only parsed ${codes.length} codes out of the union`);
  });

  for (const code of codes) {
    it(`addData.googleDrive.error.${code} is in en.json`, () => {
      const message = en.addData.googleDrive.error[code];
      assert.equal(typeof message, "string", `no en.json entry for ${code}`);
      assert.ok(message.trim().length > 0, `the en.json entry for ${code} is empty`);
    });
  }
});

describe("groupFolderVectorFiles", () => {
  const isAddable = (name: string) => /\.(shp|zip|geojson|gpkg|csv)$/i.test(name);

  function file(name: string, id = name): DriveFile {
    return { id, name, mimeType: "application/octet-stream" };
  }

  it("attaches a shapefile's sidecars to the .shp and never lists them alone", () => {
    const entries = groupFolderVectorFiles(
      [
        file("provinces.shp"),
        file("provinces.dbf"),
        file("provinces.shx"),
        file("provinces.prj"),
        file("provinces.cpg"),
      ],
      isAddable,
    );

    assert.equal(entries.length, 1, "only the .shp is an addable layer");
    assert.equal(entries[0].file.name, "provinces.shp");
    assert.deepEqual(entries[0].sidecars.map((sidecar) => sidecar.name).sort(), [
      "provinces.cpg",
      "provinces.dbf",
      "provinces.prj",
      "provinces.shx",
    ]);
  });

  it("matches sidecars case-insensitively, as Drive preserves whatever case was uploaded", () => {
    const entries = groupFolderVectorFiles([file("Roads.shp"), file("ROADS.DBF")], isAddable);
    assert.deepEqual(
      entries[0].sidecars.map((sidecar) => sidecar.name),
      ["ROADS.DBF"],
    );
  });

  it("drops an orphan sidecar rather than offering an add that cannot work", () => {
    assert.deepEqual(groupFolderVectorFiles([file("orphan.dbf")], isAddable), []);
  });

  it("keeps sidecars of one shapefile off another with a different base name", () => {
    const entries = groupFolderVectorFiles(
      [file("a.shp"), file("a.dbf"), file("b.shp"), file("b.dbf")],
      isAddable,
    );
    assert.deepEqual(
      entries.map((entry) => [entry.file.name, entry.sidecars.map((s) => s.name)]),
      [
        ["a.shp", ["a.dbf"]],
        ["b.shp", ["b.dbf"]],
      ],
    );
  });

  it("excludes subfolders and formats the loader does not accept", () => {
    const entries = groupFolderVectorFiles(
      [
        { id: "sub", name: "nested", mimeType: DRIVE_FOLDER_MIME_TYPE },
        file("notes.txt"),
        file("cities.geojson"),
      ],
      isAddable,
    );
    assert.deepEqual(
      entries.map((entry) => entry.file.name),
      ["cities.geojson"],
    );
  });

  it("attaches no sidecars to a non-shapefile that happens to share a base name", () => {
    const entries = groupFolderVectorFiles([file("cities.geojson"), file("cities.dbf")], isAddable);
    assert.deepEqual(entries[0].sidecars, []);
  });
});

describe("SHAPEFILE_SIDECAR_EXTENSIONS", () => {
  it("mirrors the loader's own sidecar list", () => {
    // The loader's copy is module-private, so this reads it out of the source.
    // If the two drift, a folder link silently downloads a .shp without the
    // component the loader wants and the add fails with a parse error.
    const source = readFileSync(
      fileURLToPath(new URL("../apps/geolibre-desktop/src/lib/tauri-io.ts", import.meta.url)),
      "utf8",
    );
    const match = /const SHAPEFILE_SIDECAR_EXTENSIONS = \[([^\]]*)\]/.exec(source);
    assert.ok(match, "could not find SHAPEFILE_SIDECAR_EXTENSIONS in tauri-io.ts");
    const loaderList = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
    assert.deepEqual([...SHAPEFILE_SIDECAR_EXTENSIONS].sort(), loaderList.sort());
  });
});

describe("pickerOutcome", () => {
  // The Picker reports everything through one `action` string, and the caller's
  // promise stays pending until this says the session ended. Getting it wrong in
  // the "keep waiting" direction hangs the Add Data dialog: it holds its
  // submitting flag until the promise settles, so the form spins with its own
  // Cancel button disabled and no way out but a reload.
  const PICKED = "picked";
  const LOADED = "loaded";

  it("reports a selection", () => {
    assert.equal(pickerOutcome(PICKED, PICKED, LOADED), "picked");
  });

  it("keeps waiting only for the one non-terminal action", () => {
    assert.equal(pickerOutcome(LOADED, PICKED, LOADED), "continue");
  });

  it("treats cancel, error, and anything unrecognized as dismissed", () => {
    // The literal reason the catch-all exists: none of these are enumerated,
    // and every one of them ends the session.
    for (const action of ["cancel", "error", "loaded:2", "", undefined]) {
      assert.equal(pickerOutcome(action, PICKED, LOADED), "dismissed", String(action));
    }
  });

  it("never treats an action as non-terminal when the API exposes no LOADED", () => {
    // With `LOADED` absent there is nothing that legitimately keeps the session
    // open, so no input may return "continue" — that is what would hang.
    for (const action of [LOADED, "cancel", "error", undefined]) {
      assert.notEqual(pickerOutcome(action, PICKED, undefined), "continue", String(action));
    }
  });
});

describe("drivePickerBlocker", () => {
  it("blocks a build that cannot sign in at all", () => {
    assert.equal(drivePickerBlocker(false, true), "unsupported");
    assert.equal(drivePickerBlocker(false, false), "unsupported");
  });

  it("blocks a supported build with no OAuth client configured", () => {
    // The case that shipped broken: GeoLibre bundles no API key, so the key is
    // always the deployment's while the fallback client is GeoLibre's own. The
    // Picker's key/app-id check therefore cannot pass, and Google answers with
    // "The API developer key is invalid", naming neither.
    assert.equal(drivePickerBlocker(true, false), "unconfigured");
  });

  it("allows a supported build with an OAuth client configured", () => {
    assert.equal(drivePickerBlocker(true, true), null);
  });

  it("reports unsupported ahead of unconfigured", () => {
    // Order matters for the UI: `unsupported` hides the control, `unconfigured`
    // shows it disabled with a fix. A build that can never sign in should not
    // advertise a setting that would not help.
    assert.equal(drivePickerBlocker(false, false), "unsupported");
  });
});

describe("the picker blocker is wired to the UI", () => {
  // `drivePickerBlocker` is a pure function with its own tests, and those passed
  // while the component silently ignored its result: the Browse button stayed
  // enabled and opened a picker that could only fail. Nothing caught it — the
  // ESLint config enables React Hooks rules only, and tsconfig sets no
  // `noUnusedLocals`, so a computed-but-unused value is invisible to both gates.
  // These read the component source, the same technique the sidecar-mirror test
  // below uses, because a green unit test on a helper says nothing about whether
  // anyone calls it.
  const source = readFileSync(
    fileURLToPath(
      new URL(
        "../apps/geolibre-desktop/src/components/layout/add-data/sources/GoogleDriveSource.tsx",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  // Collapse whitespace so the assertions survive reformatting.
  const flat = source.replace(/\s+/g, " ");

  it("computes the blocker from both the platform and the configuration", () => {
    assert.match(
      flat,
      /drivePickerBlocker\(\s*isDrivePickerAvailable\(\),\s*hasConfiguredOAuthClientId\(\)/,
    );
  });

  it("disables the Browse button when blocked", () => {
    assert.match(
      flat,
      /disabled=\{[^}]*pickerBlocked[^}]*\}/,
      "the Browse button must consume pickerBlocked, not just compute it",
    );
  });

  it("shows the configuration explanation in place of the normal help text", () => {
    assert.match(flat, /pickerBlocker === "unconfigured"/);
    assert.match(flat, /addData\.googleDrive\.pickerUnconfigured/);
  });
});

describe("canQueryDriveApi", () => {
  // Named after the operation, not the destination. Its predecessor conflated
  // "can we call the REST API" with "can we reach Drive at all" and answered
  // false for a keyless browser, which blocked the credential-free download —
  // the exact path a public share link uses (GeoLibre#1709).
  it("is true whenever a credential is present", () => {
    assert.equal(canQueryDriveApi({ apiKey: "AIza" }), true);
    assert.equal(canQueryDriveApi({ accessToken: "ya29" }), true);
  });

  it("is false with no credential, on every platform", () => {
    assert.equal(canQueryDriveApi({}), false);
  });
});

describe("the credential-free download path is not gated on the platform", () => {
  // The regression this PR shipped and a maintainer caught: the browser build
  // asked for an API key to open publicly shared data, because the public
  // download host was believed to send no CORS headers and was therefore
  // restricted to Tauri. It does send them. Nothing may reintroduce a platform
  // condition on choosing that host.
  const source = readFileSync(
    fileURLToPath(
      new URL("../apps/geolibre-desktop/src/lib/google-drive-client.ts", import.meta.url),
    ),
    "utf8",
  );
  const flat = source.replace(/\s+/g, " ");

  it("selects the download URL from the credential alone", () => {
    const choice =
      /const url = credentialFree \? drivePublicDownloadUrl\(file\.id\) : driveMediaUrl/;
    assert.match(flat, choice, "the download host must depend on the credential, not isTauri()");
  });

  it("never consults isTauri when picking the download host", () => {
    const between = flat.slice(
      flat.indexOf("const credentialFree"),
      flat.indexOf("const response = assertOk"),
    );
    assert.ok(!between.includes("isTauri"), `platform check crept back in: ${between}`);
  });
});

describe("the picker token is scoped to browse mode", () => {
  // A `drive.file` token only covers files picked in that session, so sending
  // it with a link request makes Drive answer 403 for a file that is publicly
  // shared — turning a working keyless link into "access refused".
  const source = readFileSync(
    fileURLToPath(
      new URL(
        "../apps/geolibre-desktop/src/components/layout/add-data/sources/GoogleDriveSource.tsx",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  const flat = source.replace(/\s+/g, " ");

  it("only sends the picked token while in browse mode", () => {
    assert.match(flat, /accessToken: mode === "browse" \? picked\?\.accessToken : undefined/);
  });
});
