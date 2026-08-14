import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_COMMENT_BODY_LENGTH,
  MAX_COMMENT_AUTHOR_LENGTH,
  MAX_COMMENTS_PER_SESSION,
  MAX_ID_LENGTH,
  MAX_REPLIES_PER_COMMENT,
  MIN_COMMENT_INTERVAL_MS,
  preserveStoredComments,
  validateAnchor,
  validateAuthor,
  validateComment,
  validateReply,
} from "../packages/collab-core/src/index.ts";

// -- constants ----------------------------------------------------------------

describe("comment-validate constants", () => {
  it("exports expected limits", () => {
    assert.equal(MAX_COMMENT_BODY_LENGTH, 2000);
    assert.equal(MAX_COMMENT_AUTHOR_LENGTH, 120);
    assert.equal(MAX_ID_LENGTH, 200);
    assert.equal(MIN_COMMENT_INTERVAL_MS, 250);
    assert.equal(MAX_REPLIES_PER_COMMENT, 100);
    assert.equal(MAX_COMMENTS_PER_SESSION, 500);
  });
});

// -- preserveStoredComments ---------------------------------------------------

describe("preserveStoredComments", () => {
  const stored = { comments: [{ id: "c1", body: "Persisted" }] };

  it("carries stored comments into a project that omits the key", () => {
    const result = preserveStoredComments({ layers: [] }, stored) as Record<string, unknown>;
    assert.deepEqual(result.comments, stored.comments);
    assert.deepEqual(result.layers, []);
  });

  it("keeps the incoming comments when the project supplies its own", () => {
    const incoming = { layers: [], comments: [{ id: "c2" }] };
    assert.deepEqual(preserveStoredComments(incoming, stored), incoming);
  });

  it("does not resurrect comments the sender explicitly cleared", () => {
    const incoming = { layers: [], comments: [] };
    const result = preserveStoredComments(incoming, stored) as Record<string, unknown>;
    assert.deepEqual(result.comments, []);
  });

  it("leaves the project alone when storage is empty or corrupt", () => {
    assert.deepEqual(preserveStoredComments({ layers: [] }, null), { layers: [] });
    assert.deepEqual(preserveStoredComments({ layers: [] }, "not an object"), { layers: [] });
    assert.deepEqual(preserveStoredComments({ layers: [] }, { comments: [] }), { layers: [] });
    assert.deepEqual(preserveStoredComments({ layers: [] }, { comments: "nope" }), { layers: [] });
  });

  it("passes a null or non-object project through untouched", () => {
    assert.equal(preserveStoredComments(null, stored), null);
    assert.deepEqual(preserveStoredComments([1, 2], stored), [1, 2]);
  });
});

// -- validateAnchor -----------------------------------------------------------

describe("validateAnchor", () => {
  it("accepts a valid point anchor", () => {
    const result = validateAnchor({ type: "point", lngLat: [-122.4, 37.8] });
    assert.deepEqual(result, { type: "point", lngLat: [-122.4, 37.8] });
  });

  it("rejects a point anchor with non-finite coordinates", () => {
    assert.equal(validateAnchor({ type: "point", lngLat: [NaN, 37.8] }), null);
    assert.equal(validateAnchor({ type: "point", lngLat: [Infinity, 37.8] }), null);
    assert.equal(validateAnchor({ type: "point", lngLat: [-122.4, -Infinity] }), null);
  });

  it("rejects a point anchor with wrong lngLat length", () => {
    assert.equal(validateAnchor({ type: "point", lngLat: [1] }), null);
    assert.equal(validateAnchor({ type: "point", lngLat: [1, 2, 3] }), null);
  });

  it("rejects a point anchor with non-number coordinates", () => {
    assert.equal(validateAnchor({ type: "point", lngLat: ["a", "b"] }), null);
  });

  it("rejects a point anchor with no lngLat", () => {
    assert.equal(validateAnchor({ type: "point" }), null);
  });

  it("accepts a feature anchor with string featureId", () => {
    const result = validateAnchor({
      type: "feature",
      layerId: "layer-1",
      featureId: "feat-42",
    });
    assert.deepEqual(result, {
      type: "feature",
      layerId: "layer-1",
      featureId: "feat-42",
    });
  });

  it("accepts a feature anchor with numeric featureId", () => {
    const result = validateAnchor({
      type: "feature",
      layerId: "layer-1",
      featureId: 42,
    });
    assert.deepEqual(result, {
      type: "feature",
      layerId: "layer-1",
      featureId: 42,
    });
  });

  it("includes lngLat on a feature anchor when valid", () => {
    const result = validateAnchor({
      type: "feature",
      layerId: "L",
      featureId: "F",
      lngLat: [10, 20],
    });
    assert.deepEqual(result, {
      type: "feature",
      layerId: "L",
      featureId: "F",
      lngLat: [10, 20],
    });
  });

  it("drops non-finite lngLat on a feature anchor silently", () => {
    const result = validateAnchor({
      type: "feature",
      layerId: "L",
      featureId: "F",
      lngLat: [NaN, 20],
    });
    assert.deepEqual(result, { type: "feature", layerId: "L", featureId: "F" });
  });

  it("rejects a feature anchor with empty layerId", () => {
    assert.equal(validateAnchor({ type: "feature", layerId: "", featureId: "f" }), null);
  });

  it("rejects a feature anchor with empty string featureId", () => {
    assert.equal(validateAnchor({ type: "feature", layerId: "L", featureId: "" }), null);
  });

  it("rejects a feature anchor with non-string/non-number featureId", () => {
    assert.equal(validateAnchor({ type: "feature", layerId: "L", featureId: true }), null);
  });

  it("rejects a feature anchor with NaN featureId", () => {
    assert.equal(validateAnchor({ type: "feature", layerId: "L", featureId: NaN }), null);
  });

  it("rejects a feature anchor with Infinity featureId", () => {
    assert.equal(validateAnchor({ type: "feature", layerId: "L", featureId: Infinity }), null);
  });

  it("rejects a feature anchor with oversized layerId or featureId", () => {
    const long = "x".repeat(MAX_ID_LENGTH + 1);
    assert.equal(validateAnchor({ type: "feature", layerId: long, featureId: "f" }), null);
    assert.equal(validateAnchor({ type: "feature", layerId: "L", featureId: long }), null);
  });

  it("rejects unknown anchor types", () => {
    assert.equal(validateAnchor({ type: "polygon", coords: [] }), null);
  });

  it("rejects null / undefined / primitives", () => {
    assert.equal(validateAnchor(null), null);
    assert.equal(validateAnchor(undefined), null);
    assert.equal(validateAnchor("string"), null);
    assert.equal(validateAnchor(42), null);
  });
});

// -- validateAuthor -----------------------------------------------------------

describe("validateAuthor", () => {
  it("accepts a valid author", () => {
    const result = validateAuthor({ name: "Alice", color: "#ff0000" });
    assert.deepEqual(result, { name: "Alice", color: "#ff0000" });
  });

  it("accepts a 3-digit hex color", () => {
    const result = validateAuthor({ name: "Bob", color: "#abc" });
    assert.deepEqual(result, { name: "Bob", color: "#abc" });
  });

  it("trims the name", () => {
    const result = validateAuthor({ name: "  Spaced  ", color: "#000" });
    assert.equal(result?.name, "Spaced");
  });

  it("truncates a long name", () => {
    const longName = "X".repeat(200);
    const result = validateAuthor({ name: longName, color: "#000" });
    assert.equal(result?.name.length, MAX_COMMENT_AUTHOR_LENGTH);
  });

  it("rejects an empty name after trimming", () => {
    assert.equal(validateAuthor({ name: "   ", color: "#000" }), null);
  });

  it("rejects a non-string name", () => {
    assert.equal(validateAuthor({ name: 42, color: "#000" }), null);
  });

  it("rejects an invalid hex color", () => {
    assert.equal(validateAuthor({ name: "A", color: "red" }), null);
    assert.equal(validateAuthor({ name: "A", color: "#gggggg" }), null);
    assert.equal(validateAuthor({ name: "A", color: "#12345" }), null);
  });

  it("rejects a non-string color", () => {
    assert.equal(validateAuthor({ name: "A", color: 0xff0000 }), null);
  });

  it("rejects null / undefined / primitives", () => {
    assert.equal(validateAuthor(null), null);
    assert.equal(validateAuthor(undefined), null);
    assert.equal(validateAuthor("str"), null);
  });
});

// -- validateReply ------------------------------------------------------------

describe("validateReply", () => {
  const validReply = {
    id: "r-1",
    author: { name: "Alice", color: "#abc" },
    body: "Good point",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("accepts a valid reply", () => {
    const result = validateReply(validReply);
    assert.deepEqual(result, validReply);
  });

  it("truncates a long body", () => {
    const result = validateReply({ ...validReply, body: "Z".repeat(3000) });
    assert.equal(result?.body.length, MAX_COMMENT_BODY_LENGTH);
  });

  it("rejects a whitespace-only body", () => {
    assert.equal(validateReply({ ...validReply, body: "   " }), null);
  });

  it("rejects a non-string body", () => {
    assert.equal(validateReply({ ...validReply, body: 123 }), null);
  });

  it("rejects an empty id", () => {
    assert.equal(validateReply({ ...validReply, id: "" }), null);
  });

  it("rejects a non-string id", () => {
    assert.equal(validateReply({ ...validReply, id: 42 }), null);
  });

  it("rejects an oversized id", () => {
    assert.equal(validateReply({ ...validReply, id: "r".repeat(MAX_ID_LENGTH + 1) }), null);
  });

  it("rejects an invalid author", () => {
    assert.equal(validateReply({ ...validReply, author: { name: "", color: "#000" } }), null);
    assert.equal(validateReply({ ...validReply, author: null }), null);
  });

  it("falls back to now for missing createdAt", () => {
    const { createdAt: _, ...noCreated } = validReply;
    const result = validateReply(noCreated);
    assert.ok(result);
    assert.ok(result.createdAt);
    assert.ok(!isNaN(Date.parse(result.createdAt)));
  });

  it("falls back to now for unparseable createdAt", () => {
    const result = validateReply({ ...validReply, createdAt: "not-a-date" });
    assert.ok(result);
    assert.notEqual(result.createdAt, "not-a-date");
    assert.ok(!isNaN(Date.parse(result.createdAt)));
  });

  it("rejects null / undefined / primitives", () => {
    assert.equal(validateReply(null), null);
    assert.equal(validateReply(undefined), null);
    assert.equal(validateReply(42), null);
    assert.equal(validateReply("str"), null);
  });
});

// -- validateComment ----------------------------------------------------------

describe("validateComment", () => {
  const validComment = {
    id: "c-1",
    anchor: { type: "point" as const, lngLat: [10, 20] },
    author: { name: "Alice", color: "#ff0000" },
    body: "Fix this road segment",
    createdAt: "2026-06-15T12:00:00.000Z",
    resolved: false,
    replies: [],
  };

  it("accepts a valid comment", () => {
    const result = validateComment(validComment);
    assert.deepEqual(result, validComment);
  });

  it("truncates a long body", () => {
    const result = validateComment({ ...validComment, body: "B".repeat(3000) });
    assert.ok(result);
    assert.equal(result.body.length, MAX_COMMENT_BODY_LENGTH);
  });

  it("rejects a whitespace-only body", () => {
    assert.equal(validateComment({ ...validComment, body: "  \n\t  " }), null);
  });

  it("rejects a non-string body", () => {
    assert.equal(validateComment({ ...validComment, body: false }), null);
  });

  it("rejects an empty id", () => {
    assert.equal(validateComment({ ...validComment, id: "" }), null);
  });

  it("rejects a non-string id", () => {
    assert.equal(validateComment({ ...validComment, id: 99 }), null);
  });

  it("rejects an oversized id", () => {
    assert.equal(validateComment({ ...validComment, id: "c".repeat(MAX_ID_LENGTH + 1) }), null);
  });

  it("rejects an invalid anchor", () => {
    assert.equal(validateComment({ ...validComment, anchor: { type: "bad" } }), null);
    assert.equal(validateComment({ ...validComment, anchor: null }), null);
  });

  it("rejects an invalid author", () => {
    assert.equal(
      validateComment({ ...validComment, author: { name: "X", color: "not-hex" } }),
      null,
    );
  });

  it("coerces resolved to boolean", () => {
    const result = validateComment({ ...validComment, resolved: 1 });
    assert.equal(result?.resolved, true);
    const result2 = validateComment({ ...validComment, resolved: undefined });
    assert.equal(result2?.resolved, false);
  });

  it("validates replies within a comment", () => {
    const withReplies = {
      ...validComment,
      replies: [
        {
          id: "r-1",
          author: { name: "Bob", color: "#abc" },
          body: "Agreed",
          createdAt: "2026-06-15T12:30:00.000Z",
        },
        { id: "", author: { name: "Bad", color: "#abc" }, body: "nope", createdAt: "x" },
        null,
        42,
      ],
    };
    const result = validateComment(withReplies);
    assert.ok(result);
    assert.equal(result.replies.length, 1);
    assert.equal(result.replies[0]?.id, "r-1");
  });

  it("accepts a comment with a feature anchor", () => {
    const result = validateComment({
      ...validComment,
      anchor: { type: "feature", layerId: "L", featureId: 7, lngLat: [1, 2] },
    });
    assert.ok(result);
    assert.equal(result.anchor.type, "feature");
  });

  it("falls back to now for missing createdAt", () => {
    const { createdAt: _, ...noCreated } = validComment;
    const result = validateComment(noCreated);
    assert.ok(result);
    assert.ok(!isNaN(Date.parse(result.createdAt)));
  });

  it("rejects null / undefined / primitives", () => {
    assert.equal(validateComment(null), null);
    assert.equal(validateComment(undefined), null);
    assert.equal(validateComment("string"), null);
    assert.equal(validateComment(42), null);
  });

  it("caps replies at MAX_REPLIES_PER_COMMENT", () => {
    const manyReplies = Array.from({ length: MAX_REPLIES_PER_COMMENT + 20 }, (_, i) => ({
      id: `r-${i}`,
      author: { name: "Bob", color: "#abc" },
      body: `Reply ${i}`,
      createdAt: "2026-06-15T12:30:00.000Z",
    }));
    const result = validateComment({ ...validComment, replies: manyReplies });
    assert.ok(result);
    assert.equal(result.replies.length, MAX_REPLIES_PER_COMMENT);
  });

  it("only inspects the first MAX_REPLIES_PER_COMMENT entries", () => {
    const invalid = Array.from({ length: MAX_REPLIES_PER_COMMENT }, (_, i) => ({
      id: `bad-${i}`,
      author: { name: "", color: "#abc" },
      body: `Reply ${i}`,
      createdAt: "2026-06-15T12:30:00.000Z",
    }));
    const valid = Array.from({ length: 5 }, (_, i) => ({
      id: `good-${i}`,
      author: { name: "Alice", color: "#abc" },
      body: `Reply ${i}`,
      createdAt: "2026-06-15T12:30:00.000Z",
    }));
    const result = validateComment({ ...validComment, replies: [...invalid, ...valid] });
    assert.ok(result);
    assert.equal(result.replies.length, 0);
  });

  it("falls back to now for unparseable createdAt", () => {
    const result = validateComment({ ...validComment, createdAt: "garbage" });
    assert.ok(result);
    assert.notEqual(result.createdAt, "garbage");
    assert.ok(!isNaN(Date.parse(result.createdAt)));
  });

  it("strips extra fields (returns only known shape)", () => {
    const result = validateComment({
      ...validComment,
      extraField: "should not appear",
      __proto__: { evil: true },
    });
    assert.ok(result);
    assert.equal((result as unknown as Record<string, unknown>).extraField, undefined);
  });
});
