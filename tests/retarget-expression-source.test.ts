import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { retargetExpressionSource } from "../apps/geolibre-desktop/src/lib/expression-source";

const layer = (id: string, filterExpression?: unknown[]) => ({ id, filterExpression });

describe("retargetExpressionSource", () => {
  it("seeds the textarea from the newly targeted layer's saved filter", () => {
    const next = retargetExpressionSource(
      { source: "", seededFromLayerId: null },
      layer("b", ["==", ["get", "kind"], "park"]),
    );

    assert.equal(next.source, JSON.stringify(["==", ["get", "kind"], "park"], null, 2));
    assert.equal(next.seededFromLayerId, "b");
  });

  it("clears a seeded filter when the new layer has none", () => {
    const next = retargetExpressionSource(
      { source: '["==", ["get", "kind"], "park"]', seededFromLayerId: "a" },
      layer("b"),
    );

    assert.equal(next.source, "", "layer a's filter must not follow onto layer b");
    assert.equal(next.seededFromLayerId, null);
  });

  it("keeps a hand-authored expression so it can be re-run on another layer", () => {
    const next = retargetExpressionSource(
      { source: '[">", ["get", "pop"], 1000]', seededFromLayerId: null },
      layer("b"),
    );

    assert.equal(next.source, '[">", ["get", "pop"], 1000]');
    assert.equal(next.seededFromLayerId, null);
  });

  it("treats an empty filter array as no filter", () => {
    const next = retargetExpressionSource(
      { source: '["==", ["get", "kind"], "park"]', seededFromLayerId: "a" },
      layer("b", []),
    );

    assert.equal(next.source, "");
    assert.equal(next.seededFromLayerId, null);
  });

  it("keeps a seed that still belongs to the target layer", () => {
    const next = retargetExpressionSource(
      { source: '["==", ["get", "kind"], "park"]', seededFromLayerId: "a" },
      layer("a"),
    );

    assert.equal(next.source, '["==", ["get", "kind"], "park"]');
    assert.equal(next.seededFromLayerId, null);
  });

  it("keeps authored text rather than overwriting it with the target's saved filter", () => {
    const next = retargetExpressionSource(
      { source: '[">", ["get", "pop"], 1000]', seededFromLayerId: null },
      layer("b", ["==", ["get", "kind"], "park"]),
    );

    assert.equal(next.source, '[">", ["get", "pop"], 1000]', "the user's own text survives");
    assert.equal(next.seededFromLayerId, null);
  });

  it("refreshes a seed from the target's saved filter", () => {
    const next = retargetExpressionSource(
      { source: '["==", ["get", "kind"], "park"]', seededFromLayerId: "a" },
      layer("b", [">", ["get", "pop"], 1000]),
    );

    assert.equal(next.source, JSON.stringify([">", ["get", "pop"], 1000], null, 2));
    assert.equal(next.seededFromLayerId, "b");
  });

  it("seeds over whitespace, which is not authored text", () => {
    const next = retargetExpressionSource(
      { source: "  \n ", seededFromLayerId: null },
      layer("b", [">", ["get", "pop"], 1000]),
    );

    assert.equal(next.source, JSON.stringify([">", ["get", "pop"], 1000], null, 2));
    assert.equal(next.seededFromLayerId, "b");
  });

  it("does not re-seed over edits when the target resolves to the same layer", () => {
    // Re-opening on the same layer must not discard an in-progress edit: the
    // edit unseeded the textarea, so the layer's saved filter stays put.
    const next = retargetExpressionSource(
      { source: '["==", ["get", "kind"], "par', seededFromLayerId: null },
      layer("a", ["==", ["get", "kind"], "park"]),
    );

    assert.equal(next.source, '["==", ["get", "kind"], "par');
    assert.equal(next.seededFromLayerId, null);
  });

  it("clears a seeded filter when the panel is left with no target at all", () => {
    const next = retargetExpressionSource(
      { source: '["==", ["get", "kind"], "park"]', seededFromLayerId: "a" },
      null,
    );

    assert.equal(next.source, "");
    assert.equal(next.seededFromLayerId, null);
  });
});
