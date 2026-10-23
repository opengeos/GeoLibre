import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { searchWhiteboxTools } from "../apps/geolibre-desktop/src/lib/whitebox-tool-search";

/** The catalog the app actually ships, so the ranking is measured, not mocked. */
interface SnapshotTool {
  id: string;
  display_name: string;
  category?: string;
  summary?: string;
}

const CATALOG: SnapshotTool[] = JSON.parse(
  readFileSync("apps/geolibre-desktop/public/whitebox-catalog-snapshot.json", "utf8"),
).tools;

/** The dialog's and the assistant's shared view of a tool's searchable text. */
const textOf = (tool: SnapshotTool) => ({
  name: [tool.id, tool.display_name, tool.category ?? ""].join(" "),
  identifiers: [tool.id, tool.display_name],
  summary: tool.summary ?? "",
});

const search = (query: string) => searchWhiteboxTools(CATALOG, query, textOf).map((t) => t.id);

describe("searchWhiteboxTools", () => {
  it("returns the list unchanged for a blank query", () => {
    assert.equal(searchWhiteboxTools(CATALOG, "   ", textOf).length, CATALOG.length);
  });

  it("puts every name match ahead of every summary-only match", () => {
    const named = new Set(
      CATALOG.filter((tool) => textOf(tool).name.toLowerCase().includes("slope")).map((t) => t.id),
    );
    const hits = search("slope");
    const lastNamed = hits.findLastIndex((id) => named.has(id));
    const firstOther = hits.findIndex((id) => !named.has(id));
    assert.ok(
      firstOther === -1 || lastNamed < firstOther,
      "a summary match outranked a name match",
    );
  });

  it("leads with the tool the query names", () => {
    // The regression this exists for. Splitting names from summaries restored
    // Slope to 20th of 21 name matches, which is still behind every tool whose
    // name merely contains the word; ranking exact matches first is what
    // actually puts it where it was searched for. #2566.
    assert.equal(search("slope")[0], "slope");
    assert.equal(search("watershed")[0], "watershed");
    assert.equal(search("aspect")[0], "aspect");
    assert.equal(search("fill depressions")[0], "fill_depressions");
  });

  it("matches an id whatever separator the query uses", () => {
    // Ids are snake_case and labels are Title Case, so both fold to the same
    // thing and a hyphen is nobody's mistake to make.
    for (const query of ["fill_depressions", "fill-depressions", "Fill Depressions"]) {
      assert.equal(search(query)[0], "fill_depressions", query);
    }
  });

  it("ranks prefix matches behind exact ones and ahead of the rest", () => {
    const hits = search("slope");
    const prefixed = hits.indexOf("slope_vs_aspect_plot");
    const contained = hits.indexOf("average_flowpath_slope");
    assert.ok(prefixed > 0, "Slope Vs Aspect Plot should be a prefix match");
    assert.ok(prefixed < contained, "a prefix match should outrank a contains-only match");
  });

  it("does not let a category promote every tool filed under it", () => {
    // "terrain" is one of the catalog's largest categories. Ranking it would
    // put its 36 tools ahead of the ones named after it.
    const hits = search("terrain");
    assert.ok(
      hits.indexOf("terrain_ruggedness_index") < 5,
      `expected a tool named Terrain… near the top, got ${hits.slice(0, 5).join(", ")}`,
    );
  });

  it("keeps the summary matches, which are the whole point of searching them", () => {
    // No tool is named "speckle"; four SAR filters describe themselves that way.
    const hits = search("speckle");
    assert.ok(hits.includes("lee_filter"), hits.slice(0, 5).join(", "));
    assert.ok(hits.includes("frost_filter"), hits.slice(0, 5).join(", "));
  });

  it("keeps catalog order within one tier", () => {
    // Only the tiers reorder anything: tools that match the query the same way
    // are still listed in the order the catalog gives them.
    const contained = CATALOG.filter((tool) => {
      const { identifiers } = textOf(tool);
      const folded = identifiers.map((name) => name.toLowerCase().replace(/[_-]+/g, " "));
      return (
        textOf(tool).name.toLowerCase().includes("hillshade") &&
        !folded.some((name) => name.startsWith("hillshade"))
      );
    }).map((tool) => tool.id);
    const hits = search("hillshade");
    assert.deepEqual(
      hits.filter((id) => contained.includes(id)),
      contained,
    );
  });

  it("drops tools that match neither", () => {
    assert.deepEqual(search("zzzznotatool"), []);
  });

  it("is case-insensitive and ignores surrounding space", () => {
    assert.deepEqual(search("  HILLSHADE "), search("hillshade"));
  });

  it("does not treat a separator-only query as a prefix of everything", () => {
    // "__" folds to the empty string, which every identifier starts with.
    assert.deepEqual(search("__"), []);
  });

  it("handles a tool with no summary at all", () => {
    // Five catalog entries have none; they must not throw or vanish from a
    // name search.
    const blank = CATALOG.filter((tool) => !tool.summary);
    assert.ok(blank.length > 0, "expected some tools without a summary");
    assert.ok(search(blank[0].id).includes(blank[0].id));
  });
});
