import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  createEmptyProject,
  normalizeBookmarkGroups,
  normalizeBookmarks,
  parseProject,
  projectFromStore,
  serializeProject,
  useAppStore,
  type ProjectBookmark,
} from "@geolibre/core";

const view = (id: string, over: Partial<ProjectBookmark> = {}): ProjectBookmark => ({
  id,
  name: `View ${id}`,
  lng: -122.4,
  lat: 37.8,
  zoom: 12,
  pitch: 30,
  bearing: 45,
  createdAt: 1_700_000_000_000,
  ...over,
});

describe("normalizeBookmarks", () => {
  it("keeps valid views and drops malformed or out-of-range ones", () => {
    const bookmarks = normalizeBookmarks([
      view("a"),
      view("a"), // duplicate id
      { ...view("b"), lng: 200 },
      { ...view("c"), lat: Number.NaN },
      { ...view("d"), zoom: 30 },
      { name: "no id", lng: 0, lat: 0, zoom: 1 },
      "not an object",
    ]);
    assert.deepEqual(
      bookmarks.map((bookmark) => bookmark.id),
      ["a"],
    );
  });

  it("wraps the bearing, clamps the pitch, and fills missing optional numbers", () => {
    const [bookmark] = normalizeBookmarks([
      { id: "x", name: "X", lng: 1, lat: 2, zoom: 3, pitch: 120, bearing: -90 },
    ]);
    assert.equal(bookmark.bearing, 270);
    assert.equal(bookmark.pitch, 85);
    assert.equal(bookmark.createdAt, 0);
  });

  it("drops a groupId that names no folder and keeps the captured layer state", () => {
    const groups = normalizeBookmarkGroups([{ id: "g1", name: "Parks", collapsed: true }]);
    const bookmarks = normalizeBookmarks(
      [
        view("a", { groupId: "g1", extra: { visibleLayerIds: ["roads"] } }),
        view("b", { groupId: "missing" }),
      ],
      groups,
    );
    assert.equal(bookmarks[0].groupId, "g1");
    assert.deepEqual(bookmarks[0].extra, { visibleLayerIds: ["roads"] });
    assert.equal("groupId" in bookmarks[1], false);
  });
});

describe("bookmarks in the project file", () => {
  beforeEach(() => {
    useAppStore.getState().newProject();
  });

  it("round-trips bookmarks and folders through save and load", () => {
    const project = {
      ...createEmptyProject("Views"),
      bookmarkGroups: [{ id: "g1", name: "Parks", collapsed: false }],
      bookmarks: [view("a", { groupId: "g1" }), view("b")],
    };
    const parsed = parseProject(serializeProject(project));
    assert.deepEqual(parsed.bookmarks, project.bookmarks);
    assert.deepEqual(parsed.bookmarkGroups, project.bookmarkGroups);

    useAppStore.getState().loadProject(parsed, null);
    const state = useAppStore.getState();
    assert.deepEqual(
      state.bookmarks.map((bookmark) => bookmark.id),
      ["a", "b"],
    );
    assert.deepEqual(projectFromStore(state).bookmarks, project.bookmarks);
  });

  it("leaves the keys out of a project without bookmarks", () => {
    const saved = projectFromStore(useAppStore.getState());
    assert.equal("bookmarks" in saved, false);
    assert.equal("bookmarkGroups" in saved, false);
  });

  it("marks the project dirty when the panel writes its bookmarks", () => {
    useAppStore.getState().markSaved();
    useAppStore.getState().setBookmarks([view("a")], []);
    assert.equal(useAppStore.getState().isDirty, true);
    assert.equal(useAppStore.getState().bookmarks.length, 1);
  });

  it("clears bookmarks on a new project", () => {
    useAppStore.getState().setBookmarks([view("a")], []);
    useAppStore.getState().newProject();
    assert.deepEqual(useAppStore.getState().bookmarks, []);
  });
});
