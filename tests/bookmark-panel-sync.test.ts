import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { useAppStore, type ProjectBookmark } from "@geolibre/core";
import {
  __setComponentsModuleLoaderForTests,
  closeBookmarkPanel,
  openBookmarkPanel,
  type ComponentsModules,
} from "../packages/plugins/src/plugins/maplibre-components.ts";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

const view = (id: string, over: Partial<ProjectBookmark> = {}): ProjectBookmark => ({
  id,
  name: `View ${id}`,
  lng: 10,
  lat: 20,
  zoom: 5,
  pitch: 0,
  bearing: 0,
  createdAt: 1,
  ...over,
});

/** A stand-in for maplibre-gl-components' BookmarkControl. */
class FakeBookmarkControl {
  static instances: FakeBookmarkControl[] = [];
  readonly options: Record<string, unknown>;
  bookmarks: ProjectBookmark[];
  groups: { id: string; name: string; collapsed: boolean }[];
  private readonly handlers = new Map<string, (() => void)[]>();

  constructor(options: Record<string, unknown>) {
    this.options = options;
    this.bookmarks = [...((options.bookmarks as ProjectBookmark[]) ?? [])];
    this.groups = [...((options.groups as FakeBookmarkControl["groups"]) ?? [])];
    FakeBookmarkControl.instances.push(this);
  }
  on(event: string, handler: () => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }
  emit(event: string): void {
    for (const handler of this.handlers.get(event) ?? []) handler();
  }
  getBookmarks(): ProjectBookmark[] {
    return this.bookmarks;
  }
  getGroups(): FakeBookmarkControl["groups"] {
    return this.groups;
  }
  importBookmarks(bookmarks: ProjectBookmark[]): this {
    this.bookmarks.push(...bookmarks);
    return this;
  }
  exportBookmarks(): string {
    return JSON.stringify(this.bookmarks);
  }
  // Private file-I/O hooks the host overrides.
  _exportToFile(): void {}
  _importFromFile(): void {}
  show(): this {
    return this;
  }
  expand(): this {
    return this;
  }
}

function fakeApp(importText: string | null = null): GeoLibreAppAPI {
  return {
    addMapControl: () => true,
    removeMapControl: () => true,
    importTextFile: () => Promise.resolve(importText),
  } as unknown as GeoLibreAppAPI;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
// Opening loads the control module, then shows the panel on a later task.
const settle = async () => {
  await tick();
  await tick();
};

function installLocalStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(initial));
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  return store;
}

describe("Bookmarks panel and the project", () => {
  let app: GeoLibreAppAPI;

  beforeEach(() => {
    FakeBookmarkControl.instances = [];
    __setComponentsModuleLoaderForTests(
      (): Promise<ComponentsModules> =>
        Promise.resolve([
          { BookmarkControl: FakeBookmarkControl } as unknown as NonNullable<ComponentsModules[0]>,
          null,
        ]),
    );
    installLocalStorage();
    useAppStore.getState().newProject();
    app = fakeApp();
  });

  afterEach(() => {
    closeBookmarkPanel(app);
    __setComponentsModuleLoaderForTests(null);
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("opens with the project's bookmarks and no localStorage persistence", async () => {
    useAppStore.getState().setBookmarks([view("a")], [{ id: "g", name: "F", collapsed: false }]);
    openBookmarkPanel(app);
    await tick();
    const control = FakeBookmarkControl.instances[0];
    assert.equal(control.options.storageKey, "");
    assert.deepEqual(
      control.bookmarks.map((bookmark) => bookmark.id),
      ["a"],
    );
    // The control gets copies, so its in-place edits cannot reach the store.
    assert.notEqual(control.options.bookmarks, useAppStore.getState().bookmarks);
  });

  it("writes the panel's edits back to the project", async () => {
    openBookmarkPanel(app);
    await tick();
    const control = FakeBookmarkControl.instances[0];
    control.bookmarks.push(view("new"));
    control.emit("add");
    assert.deepEqual(
      useAppStore.getState().bookmarks.map((bookmark) => bookmark.id),
      ["new"],
    );
    assert.equal(useAppStore.getState().isDirty, true);
    // Its own write does not rebuild the panel.
    assert.equal(FakeBookmarkControl.instances.length, 1);
  });

  it("saves bookmarks imported through the host's file dialog", async () => {
    app = fakeApp(JSON.stringify([view("imported")]));
    openBookmarkPanel(app);
    await tick();
    const control = FakeBookmarkControl.instances[0];
    control._importFromFile();
    await tick();
    assert.deepEqual(
      useAppStore.getState().bookmarks.map((bookmark) => bookmark.id),
      ["imported"],
    );
  });

  it("rebuilds the open panel when the project's bookmarks are replaced", async () => {
    openBookmarkPanel(app);
    await settle();
    useAppStore.getState().setBookmarks([view("loaded")], []);
    await settle();
    assert.equal(FakeBookmarkControl.instances.length, 2);
    assert.deepEqual(
      FakeBookmarkControl.instances[1].bookmarks.map((bookmark) => bookmark.id),
      ["loaded"],
    );
  });

  it("moves bookmarks saved by older versions into a project without any, once", async () => {
    const storage = installLocalStorage({
      "geolibre-bookmarks": JSON.stringify({
        bookmarks: [view("old", { groupId: "g" })],
        groups: [{ id: "g", name: "Legacy", collapsed: false }],
      }),
    });
    openBookmarkPanel(app);
    await tick();
    assert.deepEqual(
      useAppStore.getState().bookmarks.map((bookmark) => bookmark.id),
      ["old"],
    );
    assert.equal(useAppStore.getState().bookmarkGroups[0].name, "Legacy");
    // The legacy data is kept (recoverable); a marker, written once the
    // project is saved, stops a second copy.
    assert.equal(storage.has("geolibre-bookmarks"), true);
    assert.equal(storage.has("geolibre-bookmarks-migrated"), false, "not before a save");
    useAppStore.getState().markSaved();
    assert.ok(storage.get("geolibre-bookmarks-migrated"));

    closeBookmarkPanel(app);
    useAppStore.getState().newProject();
    openBookmarkPanel(app);
    await tick();
    assert.deepEqual(useAppStore.getState().bookmarks, [], "not copied into a second project");
  });

  it("copies legacy bookmarks again when the first project is discarded unsaved", async () => {
    const storage = installLocalStorage({ "geolibre-bookmarks": JSON.stringify([view("old")]) });
    openBookmarkPanel(app);
    await tick();
    closeBookmarkPanel(app);
    useAppStore.getState().newProject();
    useAppStore.getState().markSaved();
    assert.equal(storage.has("geolibre-bookmarks-migrated"), false);
    openBookmarkPanel(app);
    await tick();
    assert.deepEqual(
      useAppStore.getState().bookmarks.map((bookmark) => bookmark.id),
      ["old"],
    );
  });

  it("leaves legacy bookmarks alone when the project already has its own", async () => {
    const storage = installLocalStorage({ "geolibre-bookmarks": JSON.stringify([view("old")]) });
    useAppStore.getState().setBookmarks([view("mine")], []);
    openBookmarkPanel(app);
    await tick();
    assert.deepEqual(
      useAppStore.getState().bookmarks.map((bookmark) => bookmark.id),
      ["mine"],
    );
    assert.equal(storage.has("geolibre-bookmarks"), true);
  });
});
