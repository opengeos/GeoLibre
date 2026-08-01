import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createEmptyProject,
  parseProject,
  serializeProject,
  applyProjectToStore,
  normalizeProjectComments,
  useAppStore,
  type ProjectComment,
} from "@geolibre/core";

describe("Anchored, Persistent Comments (#1518)", () => {
  it("initializes empty project with comments array", () => {
    const project = createEmptyProject("Test Project");
    assert.deepEqual(project.comments, []);
  });

  it("normalizes and validates comment structures", () => {
    const rawComments = [
      {
        id: "c1",
        anchor: { type: "point", lngLat: [-122.4194, 37.7749] },
        author: { name: "Alice", color: "#ef4444" },
        body: "San Francisco comment",
        createdAt: "2026-08-01T12:00:00.000Z",
        resolved: false,
        replies: [
          {
            id: "r1",
            author: { name: "Bob", color: "#3b82f6" },
            body: "I agree",
            createdAt: "2026-08-01T12:05:00.000Z",
          },
        ],
      },
      {
        id: "c2",
        anchor: { type: "feature", layerId: "layer-1", featureId: "feat-99" },
        author: { name: "Charlie", color: "#10b981" },
        body: "Polygon check",
        createdAt: "2026-08-01T12:10:00.000Z",
        resolved: true,
        replies: [],
      },
      // Malformed entries should be filtered out safely
      null,
      { id: "invalid-no-anchor" },
      { id: "invalid-bad-anchor", anchor: { type: "unknown" } },
    ];

    const normalized = normalizeProjectComments(rawComments);
    assert.equal(normalized.length, 2);
    assert.equal(normalized[0].id, "c1");
    assert.equal(normalized[0].anchor.type, "point");
    assert.equal(normalized[0].replies.length, 1);
    assert.equal(normalized[1].id, "c2");
    assert.equal(normalized[1].anchor.type, "feature");
    assert.equal(normalized[1].resolved, true);
  });

  it("round-trips comments through serialization and applyProjectToStore", () => {
    const sampleComment: ProjectComment = {
      id: "comm-1",
      anchor: { type: "point", lngLat: [10.0, 20.0] },
      author: { name: "Tester", color: "#8b5cf6" },
      body: "Test comment body",
      createdAt: new Date().toISOString(),
      resolved: false,
      replies: [],
    };

    const project = createEmptyProject("Roundtrip Project");
    project.comments = [sampleComment];

    // serialize → parseProject (validates structure) → applyProjectToStore
    const jsonStr = serializeProject(project);
    const parsed = parseProject(jsonStr);

    assert.equal(Array.isArray(parsed.comments), true);
    assert.equal(parsed.comments!.length, 1);

    const applied = applyProjectToStore(parsed);
    assert.equal(applied.comments.length, 1);
    assert.equal(applied.comments[0].id, "comm-1");
    assert.equal(applied.comments[0].body, "Test comment body");
    assert.equal(applied.comments[0].anchor.type, "point");
    assert.equal(applied.comments[0].resolved, false);
  });

  it("supports store comment actions", () => {
    useAppStore.getState().newProject({ name: "Store Test" });
    assert.deepEqual(useAppStore.getState().comments, []);

    const newComment: ProjectComment = {
      id: "action-1",
      anchor: { type: "point", lngLat: [0, 0] },
      author: { name: "Store Author", color: "#3b82f6" },
      body: "Initial comment",
      createdAt: new Date().toISOString(),
      resolved: false,
      replies: [],
    };

    // Add comment
    useAppStore.getState().addComment(newComment);
    assert.equal(useAppStore.getState().comments.length, 1);

    // Reply to comment
    useAppStore.getState().replyToComment("action-1", {
      id: "rep-1",
      author: { name: "Replier", color: "#10b981" },
      body: "Replied!",
      createdAt: new Date().toISOString(),
    });
    assert.equal(useAppStore.getState().comments[0].replies.length, 1);

    // Resolve comment
    useAppStore.getState().toggleResolveComment("action-1", true);
    assert.equal(useAppStore.getState().comments[0].resolved, true);

    // Delete comment
    useAppStore.getState().deleteComment("action-1");
    assert.equal(useAppStore.getState().comments.length, 0);
  });

  it("deduplicates addComment calls with the same id (relay echo guard)", () => {
    useAppStore.getState().newProject({ name: "Dedup Test" });

    const comment: ProjectComment = {
      id: "dedup-1",
      anchor: { type: "point", lngLat: [5, 10] },
      author: { name: "Echo", color: "#3b82f6" },
      body: "Only once",
      createdAt: new Date().toISOString(),
      resolved: false,
      replies: [],
    };

    useAppStore.getState().addComment(comment);
    useAppStore.getState().addComment(comment); // simulated relay echo
    assert.equal(useAppStore.getState().comments.length, 1);
  });

  afterEach(() => {
    // Reset the singleton store so tests don't share state.
    useAppStore.getState().newProject({ name: "reset" });
  });
});
