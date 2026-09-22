import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SEMANTIC_SPARSE_HITS,
  shouldSearchWhiteboxByMeaning,
  whiteboxCatalogTool,
} from "../apps/geolibre-desktop/src/lib/whitebox-semantic-search";

describe("shouldSearchWhiteboxByMeaning", () => {
  it("ignores a query too short to be a request", () => {
    // One or two characters are a prefix someone is still typing.
    assert.equal(shouldSearchWhiteboxByMeaning("", 0), false);
    assert.equal(shouldSearchWhiteboxByMeaning("sl", 0), false);
    assert.equal(shouldSearchWhiteboxByMeaning("  s  ", 0), false);
  });

  it("always runs for a phrase, however much the filter found", () => {
    // Several words describe an operation, which is exactly what a substring
    // match cannot answer — "remove sinks" finds nothing, and the tool is
    // called fill_depressions.
    assert.equal(shouldSearchWhiteboxByMeaning("remove sinks from a dem", 0), true);
    assert.equal(shouldSearchWhiteboxByMeaning("flow accumulation", 40), true);
  });

  it("leaves a productive one-word search to the filter", () => {
    // "slope" already returns 21 tools with the one called Slope first; a round
    // trip would only reorder a list someone is reading.
    assert.equal(shouldSearchWhiteboxByMeaning("slope", 21), false);
    assert.equal(shouldSearchWhiteboxByMeaning("slope", SEMANTIC_SPARSE_HITS), false);
  });

  it("runs for a one-word search the catalog barely matches", () => {
    // No tool is named or described as "grainy"; the emptiness is the case the
    // lookup exists for.
    assert.equal(shouldSearchWhiteboxByMeaning("grainy", 0), true);
    assert.equal(shouldSearchWhiteboxByMeaning("grainy", SEMANTIC_SPARSE_HITS - 1), true);
  });
});

describe("whiteboxCatalogTool", () => {
  it("describes a tool with the catalog's own English strings", () => {
    // Not the translated label the list renders: the questions are asked in
    // English, and an identical request in every locale keeps a bad answer
    // reproducible.
    assert.deepEqual(
      whiteboxCatalogTool({
        id: "fill_depressions",
        display_name: "Fill Depressions",
        category: "Hydrology - Depressions",
        summary: "Fills all of the depressions in a DEM.",
      }),
      {
        id: "fill_depressions",
        name: "Fill Depressions",
        category: "Hydrology - Depressions",
        description: "Fills all of the depressions in a DEM.",
      },
    );
  });

  it("humanizes the id when the catalog carries no display name", () => {
    assert.deepEqual(whiteboxCatalogTool({ id: "d8_pointer" }), {
      id: "d8_pointer",
      name: "D8 Pointer",
      category: "",
      description: undefined,
    });
  });
});
