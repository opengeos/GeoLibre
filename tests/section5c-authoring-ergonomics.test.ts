import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  exportAtlasPdf,
  exportAtlasPngZip,
} from "../apps/geolibre-desktop/src/lib/print-layout-export";
import {
  MAX_MODEL_HISTORY,
  addDataNode,
  clampCanvasZoom,
  connectNodes,
  createModelHistory,
  duplicateNodes,
  emptyModelGraph,
  moveNodes,
  pushModelHistory,
  redoModelHistory,
  removeNodes,
  undoModelHistory,
} from "../apps/geolibre-desktop/src/lib/model-graph-edit";
import {
  computeBulkFillDrafts,
  computeFindReplaceDrafts,
  filterAttributeRowsByColumns,
  hasActiveColumnFilter,
  matchesColumnFilter,
  sortAttributeRows,
  toggleMultiSort,
} from "../apps/geolibre-desktop/src/lib/attribute-table-ops";
import {
  colorForGraduatedValue,
  computeGraduatedHistogram,
} from "../apps/geolibre-desktop/src/components/panels/style-panel/graduated-histogram";
import {
  isExternalPluginManifest,
  isPluginCapabilityList,
  PLUGIN_CAPABILITIES,
} from "../apps/geolibre-desktop/src/lib/plugin-archive-unpack";

describe("PR 5c: Print Layout Atlas cancellation", () => {
  it("aborts multi-page PDF and ZIP atlas exports immediately when AbortSignal fires", async () => {
    const controller = new AbortController();
    let pdfCalls = 0;
    await assert.rejects(
      () =>
        exportAtlasPdf(
          {
            total: 5,
            signal: controller.signal,
            optionsForPage: async () => {
              pdfCalls += 1;
              controller.abort();
              return {} as never;
            },
          },
          "test-atlas.pdf",
        ),
      (err: unknown) => err instanceof DOMException && err.name === "AbortError",
    );
    assert.equal(pdfCalls, 1, "PDF atlas loop must stop on abort");

    const zipController = new AbortController();
    zipController.abort();
    let zipCalls = 0;
    await assert.rejects(
      () =>
        exportAtlasPngZip(
          {
            total: 3,
            signal: zipController.signal,
            optionsForPage: async () => {
              zipCalls += 1;
              throw new Error("should never run when pre-aborted");
            },
          },
          (i) => `page-${i + 1}`,
          "test-atlas.zip",
        ),
      (err: unknown) => err instanceof DOMException && err.name === "AbortError",
    );
    assert.equal(zipCalls, 0);
  });
});

describe("PR 5c: Model Builder undo/redo, zoom clamp, multi-select duplicate & move", () => {
  it("tracks bounded undo/redo history and clears redo on fresh edit", () => {
    let idSeq = 0;
    const nextId = () => `n-${++idSeq}`;
    const g0 = emptyModelGraph();
    const g1 = addDataNode(g0, "input", { x: 20, y: 20 }, nextId).graph;
    const g2 = addDataNode(g1, "output", { x: 240, y: 20 }, nextId).graph;

    let history = createModelHistory();
    history = pushModelHistory(history, g0);
    history = pushModelHistory(history, g1);

    const u1 = undoModelHistory(history, g2);
    assert.ok(u1);
    assert.equal(u1.graph.nodes.length, 1);
    const u2 = undoModelHistory(u1.history, u1.graph);
    assert.ok(u2);
    assert.equal(u2.graph.nodes.length, 0);
    assert.equal(undoModelHistory(u2.history, u2.graph), null);

    const r1 = redoModelHistory(u2.history, u2.graph);
    assert.ok(r1);
    assert.equal(r1.graph.nodes.length, 1);

    // A fresh push clears the redo stack and enforces MAX_MODEL_HISTORY.
    let capped = pushModelHistory(r1.history, r1.graph);
    assert.equal(capped.future.length, 0);
    for (let i = 0; i < MAX_MODEL_HISTORY + 15; i += 1) {
      capped = pushModelHistory(capped, g0);
    }
    assert.equal(capped.past.length, MAX_MODEL_HISTORY);
  });

  it("duplicates selected nodes with internal edges only, moves groups, deletes batches, and clamps zoom", () => {
    let idSeq = 0;
    const nextId = () => `id-${++idSeq}`;
    const a = addDataNode(emptyModelGraph(), "input", { x: 10, y: 10 }, nextId);
    const b = addDataNode(a.graph, "output", { x: 200, y: 10 }, nextId);
    const c = addDataNode(b.graph, "output", { x: 400, y: 10 }, nextId);
    const wired1 = connectNodes(
      c.graph,
      { nodeId: a.nodeId, portId: "out" },
      { nodeId: b.nodeId, portId: "in" },
      nextId,
    );
    assert.ok("graph" in wired1);
    const wired2 = connectNodes(
      wired1.graph,
      { nodeId: a.nodeId, portId: "out" },
      { nodeId: c.nodeId, portId: "in" },
      nextId,
    );
    assert.ok("graph" in wired2);

    // Duplicate only {a, b}: edge a->b must be cloned, edge a->c must NOT be cloned.
    const dup = duplicateNodes(wired2.graph, [a.nodeId, b.nodeId], nextId, { x: 30, y: 50 });
    assert.equal(dup.nodeIds.length, 2);
    assert.equal(dup.graph.nodes.length, 5);
    assert.equal(dup.graph.edges.length, 3);
    const clonedEdge = dup.graph.edges[2];
    assert.equal(clonedEdge.from, dup.nodeIds[0]);
    assert.equal(clonedEdge.to, dup.nodeIds[1]);

    // Move multiple nodes at once.
    const moved = moveNodes(
      dup.graph,
      new Map([
        [dup.nodeIds[0], { x: 100, y: 200 }],
        [dup.nodeIds[1], { x: 300, y: 200 }],
      ]),
    );
    assert.equal(moved.nodes.find((n) => n.id === dup.nodeIds[0])?.x, 100);
    assert.equal(moved.nodes.find((n) => n.id === dup.nodeIds[1])?.x, 300);

    // Batch remove duplicated nodes and their edges.
    const cleaned = removeNodes(moved, dup.nodeIds);
    assert.equal(cleaned.nodes.length, 3);
    assert.equal(cleaned.edges.length, 2);

    // Canvas zoom bounds.
    assert.equal(clampCanvasZoom(0.1), 0.4);
    assert.equal(clampCanvasZoom(5), 2);
    assert.equal(clampCanvasZoom(Number.NaN), 1);
  });
});

describe("PR 5c: Attribute Table multi-sort, column filters, and bulk edit", () => {
  const rows = [
    { featureId: "1", properties: { region: "West", pop: 200, note: "alpha city" } },
    { featureId: "2", properties: { region: "East", pop: 500, note: "Alpha town" } },
    { featureId: "3", properties: { region: "West", pop: 50, note: null } },
    { featureId: "4", properties: { region: "East", pop: 100, note: "beta" } },
  ];

  it("supports Shift+click multi-column sorting", () => {
    let specs = toggleMultiSort([{ key: "__featureId", direction: "asc" }], "region", false);
    specs = toggleMultiSort(specs, "pop", true);
    assert.deepEqual(specs, [
      { key: "region", direction: "asc" },
      { key: "pop", direction: "asc" },
    ]);
    const sorted = sortAttributeRows(rows, specs);
    assert.deepEqual(
      sorted.map((r) => r.featureId),
      ["4", "2", "3", "1"],
    );

    // Shift+click secondary key again flips to desc, then removes it.
    specs = toggleMultiSort(specs, "pop", true);
    assert.equal(specs[1].direction, "desc");
    assert.deepEqual(
      sortAttributeRows(rows, specs).map((r) => r.featureId),
      ["2", "4", "1", "3"],
    );
    specs = toggleMultiSort(specs, "pop", true);
    assert.equal(specs.length, 1);
  });

  it("evaluates per-column contains, equals, numeric range, is-null, and not-null filters", () => {
    assert.equal(hasActiveColumnFilter({ mode: "contains", text: "   " }), false);
    assert.equal(hasActiveColumnFilter({ mode: "is-null" }), true);
    assert.equal(matchesColumnFilter(null, { mode: "is-null" }), true);
    assert.equal(matchesColumnFilter("x", { mode: "not-null" }), true);

    const filtered = filterAttributeRowsByColumns(rows, {
      region: { mode: "equals", text: "east" },
      pop: { mode: "range", min: "150", max: "600" },
    });
    assert.deepEqual(
      filtered.map((r) => r.featureId),
      ["2"],
    );
  });

  it("computes bulk fill and Find & Replace drafts on selected rows", () => {
    const selected = new Set(["1", "2"]);
    const replaced = computeFindReplaceDrafts({
      rows,
      targetRowIds: selected,
      column: "note",
      find: "alpha",
      replace: "gamma",
      matchCase: false,
      wholeCell: false,
      currentDrafts: {},
    });
    assert.equal(replaced.updatedCount, 2);
    assert.equal(replaced.drafts["1"]?.note, "gamma city");
    assert.equal(replaced.drafts["2"]?.note, "gamma town");
    assert.equal(replaced.drafts["4"], undefined);

    const filled = computeBulkFillDrafts({
      rows,
      targetRowIds: new Set(["3", "4"]),
      column: "region",
      value: "South",
      currentDrafts: replaced.drafts,
    });
    assert.equal(filled.updatedCount, 2);
    assert.equal(filled.drafts["3"]?.region, "South");
    assert.equal(filled.drafts["4"]?.region, "South");
    assert.equal(filled.drafts["1"]?.note, "gamma city");
  });
});

describe("PR 5c: Graduated Symbology inline distribution histogram", () => {
  it("bins numeric values, maps stop colors, and computes break positions", () => {
    const stops = [
      { value: 0, color: "#fee5d9" },
      { value: 50, color: "#fcae91" },
      { value: 100, color: "#cb181d" },
    ];
    assert.equal(colorForGraduatedValue(10, stops), "#fee5d9");
    assert.equal(colorForGraduatedValue(50, stops), "#fcae91");
    assert.equal(colorForGraduatedValue(120, stops), "#cb181d");

    const hist = computeGraduatedHistogram([0, 10, 20, 55, 95, 100, null, "bad"], stops, 4);
    assert.ok(hist);
    assert.equal(hist.totalCount, 6);
    assert.equal(hist.min, 0);
    assert.equal(hist.max, 100);
    assert.equal(hist.bins.length, 4);
    assert.equal(
      hist.bins.reduce((sum, b) => sum + b.count, 0),
      6,
    );
    assert.equal(hist.breakPositions.length, 3);
    assert.equal(hist.breakPositions[1].position, 0.5);

    // Non-numeric attributes return null gracefully.
    assert.equal(computeGraduatedHistogram(["a", "b", null], stops), null);
  });
});

describe("PR 5c: External plugin capabilities manifest validation", () => {
  it("accepts declared capability identifiers and rejects unknown ones", () => {
    assert.ok(PLUGIN_CAPABILITIES.includes("network"));
    assert.equal(isPluginCapabilityList(["network", "mapWrite", "ui"]), true);
    assert.equal(isPluginCapabilityList(["network", "root-shell"]), false);

    assert.equal(
      isExternalPluginManifest({
        id: "demo-plugin",
        name: "Demo Plugin",
        version: "1.0.0",
        entry: "index.js",
        capabilities: ["network", "filesystem"],
      }),
      true,
    );
    assert.equal(
      isExternalPluginManifest({
        id: "demo-plugin",
        name: "Demo Plugin",
        version: "1.0.0",
        entry: "index.js",
        capabilities: ["unknown-cap"],
      }),
      false,
    );
  });
});
