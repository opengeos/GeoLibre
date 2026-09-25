import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

// These modules import Tauri plugin wrappers, which are safe to load under Node
// as long as nothing calls into them (every path below stays in the browser
// branch because `window.__TAURI_INTERNALS__` is absent).
import { saveProjectFile } from "../apps/geolibre-desktop/src/lib/file-io/project-files";
import { photoPickPaths } from "../apps/geolibre-desktop/src/lib/file-io/raster-photo-files";

describe("photoPickPaths", () => {
  it("returns nothing for a cancelled dialog", () => {
    assert.deepEqual(photoPickPaths(null, true), []);
    assert.deepEqual(photoPickPaths(null, false), []);
  });

  it("filters desktop picks by image extension", () => {
    assert.deepEqual(photoPickPaths(["/p/a.jpg", "/p/notes.txt", "/p/b.HEIC"], true), [
      "/p/a.jpg",
      "/p/b.HEIC",
    ]);
    assert.deepEqual(photoPickPaths("/p/a.png", true), ["/p/a.png"]);
  });

  it("keeps extensionless Android content URIs from the mobile picker", () => {
    const uris = [
      "content://com.android.providers.media.documents/document/image%3A1234",
      "content://media/external/images/media/42",
    ];
    assert.deepEqual(photoPickPaths(uris, false), uris);
    assert.deepEqual(photoPickPaths(uris[0], false), [uris[0]]);
  });
});

describe("saveProjectFile in the browser", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalWarn = console.warn;
  let warnings: unknown[][];

  beforeEach(() => {
    warnings = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
    for (const [name, descriptor] of [
      ["window", originalWindow],
      ["document", originalDocument],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  function setGlobal(name: "window" | "document", value: unknown): void {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }

  it("writes through the save picker with the project file type", async () => {
    let pickerOptions: unknown;
    let written: unknown;
    setGlobal("window", {
      showSaveFilePicker: async (options: unknown) => {
        pickerOptions = options;
        return {
          name: "mine.geolibre",
          createWritable: async () => ({
            write: async (content: unknown) => {
              written = content;
            },
            close: async () => undefined,
          }),
        };
      },
    });

    const saved = await saveProjectFile("{}", "/some/dir/My Map.geolibre");

    assert.equal(saved, "mine.geolibre");
    assert.equal(written, "{}");
    assert.deepEqual(pickerOptions, {
      suggestedName: "My Map.geolibre",
      types: [
        {
          description: "GeoLibre Project",
          accept: { "application/json": [".geolibre", ".json"] },
        },
      ],
      excludeAcceptAllOption: false,
    });
    assert.equal(warnings.length, 0);
  });

  it("returns null when the picker is cancelled", async () => {
    setGlobal("window", {
      showSaveFilePicker: async () => {
        throw new DOMException("The user aborted a request.", "AbortError");
      },
    });

    assert.equal(await saveProjectFile("{}"), null);
    assert.equal(warnings.length, 0);
  });

  it("falls back to a JSON download named project.geolibre when the picker fails", async () => {
    setGlobal("window", {
      showSaveFilePicker: async () => {
        throw new Error("boom");
      },
    });
    const clicked: { download: string; href: string }[] = [];
    setGlobal("document", {
      createElement: () => {
        const link = {
          href: "",
          download: "",
          style: {} as Record<string, string>,
          click: () => clicked.push({ download: link.download, href: link.href }),
          remove: () => undefined,
        };
        return link;
      },
      body: { appendChild: () => undefined },
    });
    const blobs: Blob[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (blob: Blob) => {
      blobs.push(blob);
      return "blob:test";
    };
    URL.revokeObjectURL = () => undefined;

    try {
      const saved = await saveProjectFile('{"a":1}');

      assert.equal(saved, "project.geolibre");
      assert.deepEqual(clicked, [{ download: "project.geolibre", href: "blob:test" }]);
      assert.equal(blobs[0].type, "application/json");
      assert.equal(await blobs[0].text(), '{"a":1}');
      assert.equal(warnings[0][0], "Browser project save picker failed");
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });
});
