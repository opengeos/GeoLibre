import { useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createEmptyProject, projectFromStore } from "@geolibre/core";
import {
  rebaseImportedDocumentLayer,
  rebaseImportedDocumentPath,
} from "../packages/core/src/imported-document-paths";
import { geojsonLayer } from "./helpers/layer-fixtures";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import {
  initializeNativeDocumentCopies,
  restoreNativeDocumentCopies,
} from "../apps/geolibre-desktop/src/lib/native-document-copies";
import { isImportedDocumentCopyPath } from "../apps/geolibre-desktop/src/lib/file-io/paths";
import i18next from "i18next";
import en from "../apps/geolibre-desktop/src/i18n/locales/en.json";
import { clearNotifications, useNotificationStore } from "../apps/geolibre-desktop/src/lib/notify";

const selection = "3cb9b477-d563-4d3e-8503-263ec23c01c5";
const oldRoot =
  "/private/var/mobile/Containers/Data/Application/old/Library/Application Support/org.geolibre.app/picked-documents";
const currentRoot =
  "/private/var/mobile/Containers/Data/Application/current/Library/Application Support/org.geolibre.app/picked-documents";
const oldPath = `${oldRoot}/${selection}/data/map % # é.geojson`;
const currentPath = `${currentRoot}/${selection}/data/map % # é.geojson`;

describe("retained iOS document references", () => {
  it("keeps healthy references available and waits for translations before reporting a problem", async () => {
    await i18next.init({ lng: "en", resources: { en: { translation: en } } });
    clearNotifications();
    mockIPC(() => ({ root: currentRoot, problems: ["One import is unreadable"] }));
    let translate!: () => void;
    const translationReady = new Promise<void>((resolve) => {
      translate = resolve;
    });
    let installed!: () => void;
    const rootReady = new Promise<void>((resolve) => {
      installed = resolve;
    });
    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.nativeDocumentCopyRoot === currentRoot) installed();
    });
    let ready: Promise<void> | undefined;
    try {
      ready = restoreNativeDocumentCopies(translationReady);
      await rootReady;
      assert.equal(useAppStore.getState().nativeDocumentCopyRoot, currentRoot);
      assert.equal(useNotificationStore.getState().notifications.length, 0);
      translate();
      await ready;
      const notices = useNotificationStore.getState().notifications;
      assert.equal(notices.length, 1);
      assert.equal(notices[0].message, en.notifications.nativeDocumentCopiesFailed);
    } finally {
      translate();
      await ready;
      unsubscribe();
      clearMocks();
      clearNotifications();
      useAppStore.getState().setNativeDocumentCopyRoot(null);
    }
  });

  it("settles catastrophic initialization with actionable guidance so the workspace can open", async () => {
    await i18next.init({ lng: "en", resources: { en: { translation: en } } });
    clearNotifications();
    mockIPC(() => {
      throw new Error("Storage path unavailable");
    });
    try {
      await restoreNativeDocumentCopies(Promise.resolve());
      assert.equal(useAppStore.getState().nativeDocumentCopyRoot, null);
      assert.equal(
        useAppStore.getState().nativeDocumentCopyError,
        en.notifications.nativeDocumentCopiesInitFailed,
      );
      const notices = useNotificationStore.getState().notifications;
      assert.equal(notices.length, 1);
      assert.equal(notices[0].message, en.notifications.nativeDocumentCopiesInitFailed);
      assert.ok(notices[0].diagnostic);
    } finally {
      clearMocks();
      clearNotifications();
      useAppStore.getState().setNativeDocumentCopyRoot(null);
    }
  });

  it("holds retained references before publication during an outage and recovers the original project", async () => {
    await i18next.init({ lng: "en", resources: { en: { translation: en } } });
    const store = useAppStore.getState();
    store.newProject({ name: "Keep this workspace", layers: [geojsonLayer({ id: "keep" })] });
    store.addLayer(geojsonLayer({ id: "keep-also" }));
    store.setProjectPath("/tmp/keep.geolibre.json");
    clearNotifications();
    mockIPC(() => {
      throw new Error("Storage path unavailable");
    });
    let translate!: () => void;
    const translationReady = new Promise<void>((resolve) => {
      translate = resolve;
    });
    let blocked!: () => void;
    const failureReady = new Promise<void>((resolve) => {
      blocked = resolve;
    });
    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.nativeDocumentCopyError !== null) blocked();
    });
    let ready: Promise<void> | undefined;
    try {
      ready = restoreNativeDocumentCopies(translationReady);
      await failureReady;
      assert.equal(useNotificationStore.getState().notifications.length, 0);
      const before = useAppStore.getState();
      const pastCount = useAppStore.temporal.getState().pastStates.length;
      const futureCount = useAppStore.temporal.getState().futureStates.length;
      const project = createEmptyProject("Retained source");
      const references = [
        geojsonLayer({ sourcePath: oldPath }),
        geojsonLayer({ metadata: { localFilePath: oldPath } }),
        geojsonLayer({
          metadata: { localBytesUrl: `asset://localhost/${encodeURIComponent(oldPath)}` },
        }),
        geojsonLayer({
          source: {
            type: "vector",
            url: `pmtiles://local-pmtiles://localhost/file?path=${encodeURIComponent(oldPath)}`,
          },
        }),
        geojsonLayer({
          type: "raster",
          geojson: undefined,
          source: {
            type: "raster",
            tiles: [`geolibre-mbtiles://tile/{z}/{x}/{y}?path=${encodeURIComponent(oldPath)}`],
          },
        }),
      ];
      let published = 0;
      const observeLayers = useAppStore.subscribe((state) => {
        if (state.layers !== before.layers) published++;
      });
      try {
        for (const layer of references) {
          project.layers = [layer];
          assert.throws(
            () => store.loadProject(project, "/tmp/retained.geolibre.json"),
            /Could not restore access/,
          );
          assert.throws(() => store.newProject({ layers: [layer] }), /Could not restore access/);
          assert.throws(() => store.addLayer(layer), /Could not restore access/);
        }
        const after = useAppStore.getState();
        assert.equal(published, 0);
        assert.equal(after.projectGeneration, before.projectGeneration);
        assert.equal(after.projectLoadCount, before.projectLoadCount);
        assert.equal(after.projectPath, before.projectPath);
        assert.equal(after.isDirty, before.isDirty);
        assert.equal(after.layers === before.layers, true);
        assert.equal(useAppStore.temporal.getState().pastStates.length, pastCount);
        assert.equal(useAppStore.temporal.getState().futureStates.length, futureCount);
      } finally {
        observeLayers();
      }

      // An unrelated workspace remains available while retained files are held.
      store.newProject();
      const remote = createEmptyProject("Remote data");
      remote.layers = [
        geojsonLayer({
          source: {
            type: "geojson",
            url: `https://example.com/data?path=${encodeURIComponent(oldPath)}`,
          },
        }),
      ];
      store.loadProject(remote);
      assert.equal(useAppStore.getState().layers[0].source.url, remote.layers[0].source.url);
      assert.equal("nativeDocumentCopyError" in projectFromStore(useAppStore.getState()), false);

      translate();
      await ready;
      clearNotifications();
      mockIPC(() => ({ root: currentRoot, problems: [] }));
      await restoreNativeDocumentCopies(Promise.resolve());
      assert.equal(useAppStore.getState().nativeDocumentCopyError, null);
      assert.equal(useNotificationStore.getState().notifications.length, 0);
      project.layers = [references[0]];
      store.loadProject(project, "/tmp/retained.geolibre.json");
      assert.equal(useAppStore.getState().layers[0].sourcePath, currentPath);
      assert.equal(project.layers[0].sourcePath, oldPath);
    } finally {
      translate();
      await ready;
      unsubscribe();
      clearMocks();
      clearNotifications();
      useAppStore.getState().setNativeDocumentCopyRoot(null);
      useAppStore.getState().newProject();
    }
  });

  it("recognizes and rebases the copy layout for the shipped iOS identifier", () => {
    const config = JSON.parse(
      readFileSync(
        new URL("../apps/geolibre-desktop/src-tauri/tauri.ios.conf.json", import.meta.url),
        "utf8",
      ),
    );
    const configuredOldPath = oldPath.replace("org.geolibre.app", config.identifier);
    const configuredRoot = currentRoot.replace("org.geolibre.app", config.identifier);
    const expected = currentPath.replace("org.geolibre.app", config.identifier);
    assert.equal(isImportedDocumentCopyPath(configuredOldPath), true);
    assert.equal(rebaseImportedDocumentPath(configuredOldPath, configuredRoot), expected);
  });

  it("installs the current root even when an individual import is unavailable", async () => {
    mockIPC((command) => {
      assert.equal(command, "initialize_native_document_copies");
      return { root: currentRoot, problems: ["One import is unreadable"] };
    });
    try {
      const problems = await initializeNativeDocumentCopies();
      assert.equal(problems.length, 1);
      assert.equal(useAppStore.getState().nativeDocumentCopyRoot, currentRoot);
    } finally {
      clearMocks();
      useAppStore.getState().setNativeDocumentCopyRoot(null);
    }
  });

  it("waits for native authorization before publishing the current root", async () => {
    let complete!: (value: { root: string; problems: string[] }) => void;
    mockIPC(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    try {
      const ready = initializeNativeDocumentCopies();
      assert.equal(useAppStore.getState().nativeDocumentCopyRoot, null);
      complete({ root: currentRoot, problems: [] });
      await ready;
      assert.equal(useAppStore.getState().nativeDocumentCopyRoot, currentRoot);
    } finally {
      clearMocks();
      useAppStore.getState().setNativeDocumentCopyRoot(null);
    }
  });

  it("keeps the selection and filename when the container changes", () => {
    assert.equal(rebaseImportedDocumentPath(oldPath, currentRoot), currentPath);
    assert.equal(rebaseImportedDocumentPath(currentPath, currentRoot), currentPath);
  });

  it("does not reinterpret stages, traversal, URLs, or unrelated files", () => {
    for (const path of [
      `${oldRoot}/.pending-${selection}/data/map.geojson`,
      `${oldRoot}/${selection}/source.json`,
      `${oldRoot}/${selection}/data/../source.json`,
      `${oldRoot}/${selection}/data/map\\draft.geojson`,
      `${oldRoot}/${selection}/data/${"é".repeat(130)}.geojson`,
      "https://example.com/map.geojson",
      "/private/var/mobile/Documents/Inbox/map.geojson",
      `/data/user/0/org.geolibre.app/files/picked-documents/${selection}/data/map.geojson`,
    ])
      assert.equal(rebaseImportedDocumentPath(path, currentRoot), path);
    for (const root of [
      "relative/picked-documents",
      "//server/picked-documents",
      "/data/../picked-documents",
      "/data",
    ]) {
      assert.equal(rebaseImportedDocumentPath(oldPath, root), oldPath);
    }
  });

  it("rebases vector and raster references without mutating the saved layer", () => {
    const layer = geojsonLayer({ sourcePath: oldPath, metadata: { localFilePath: oldPath } });
    const result = rebaseImportedDocumentLayer(layer, currentRoot);
    assert.equal(result.sourcePath, currentPath);
    assert.equal(result.metadata.localFilePath, currentPath);
    assert.equal(layer.sourcePath, oldPath);
    assert.equal(rebaseImportedDocumentLayer(layer, null), layer);
  });

  it("rebuilds local-media paths without changing coordinate placeholders or remote URLs", () => {
    const tile = `geolibre-mbtiles://tile/{z}/{x}/{y}?path=${encodeURIComponent(oldPath)}&mode=raster`;
    const layer = geojsonLayer({
      source: { type: "raster", tiles: [tile] },
      metadata: { localBytesUrl: `asset://localhost/${encodeURIComponent(oldPath)}` },
    });
    const result = rebaseImportedDocumentLayer(layer, currentRoot);
    assert.equal(
      (result.source.tiles as string[])[0],
      `geolibre-mbtiles://tile/{z}/{x}/{y}?path=${encodeURIComponent(currentPath)}&mode=raster`,
    );
    assert.equal(
      result.metadata.localBytesUrl,
      `asset://localhost/${encodeURIComponent(currentPath)}`,
    );
    const archive = geojsonLayer({
      source: {
        type: "vector",
        url: `pmtiles://local-pmtiles://localhost/file?path=${encodeURIComponent(oldPath)}`,
      },
    });
    assert.equal(
      rebaseImportedDocumentLayer(archive, currentRoot).source.url,
      `pmtiles://local-pmtiles://localhost/file?path=${encodeURIComponent(currentPath)}`,
    );
    const remote = geojsonLayer({
      source: {
        type: "geojson",
        url: `https://example.com/file?path=${encodeURIComponent(oldPath)}`,
      },
    });
    assert.equal(rebaseImportedDocumentLayer(remote, currentRoot), remote);
  });

  it("normalizes a reopened project before readers observe its layers", () => {
    const store = useAppStore.getState();
    store.setNativeDocumentCopyRoot(currentRoot);
    try {
      const project = createEmptyProject("Retained copies");
      project.layers = [
        geojsonLayer({
          sourcePath: oldPath,
          metadata: { localFilePath: oldPath, localFileReloadable: true },
        }),
      ];
      store.loadProject(project);
      const loaded = useAppStore.getState();
      assert.equal(loaded.layers[0].sourcePath, currentPath);
      assert.equal(loaded.layers[0].metadata.localFilePath, currentPath);
      const saved = projectFromStore(loaded);
      assert.equal(saved.layers[0].sourcePath, currentPath);
      assert.equal("nativeDocumentCopyRoot" in saved, false);
      assert.equal(project.layers[0].sourcePath, oldPath);
    } finally {
      useAppStore.getState().setNativeDocumentCopyRoot(null);
      useAppStore.getState().newProject();
    }
  });

  it("normalizes default and library layers with the same current root", () => {
    const store = useAppStore.getState();
    store.setNativeDocumentCopyRoot(currentRoot);
    try {
      const layer = geojsonLayer({ sourcePath: oldPath });
      store.newProject({ layers: [layer] });
      assert.equal(useAppStore.getState().layers[0].sourcePath, currentPath);
      store.newProject();
      store.addLayer(layer);
      assert.equal(useAppStore.getState().layers[0].sourcePath, currentPath);
    } finally {
      useAppStore.getState().setNativeDocumentCopyRoot(null);
      useAppStore.getState().newProject();
    }
  });
});
