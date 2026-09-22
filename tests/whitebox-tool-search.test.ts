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

  it("restores the rank a summary-free catalog would have given", () => {
    // The regression this exists for. ~30 tools mention "slope" in passing, so
    // searching one joined string pushed the tool called Slope from 20th of 21
    // hits to 47th of 51 — it fell off the visible list.
    const hits = search("slope");
    const named = CATALOG.filter((tool) => textOf(tool).name.toLowerCase().includes("slope"));
    assert.equal(
      hits.indexOf("slope"),
      named.findIndex((t) => t.id === "slope"),
    );
    assert.ok(hits.length > named.length, "the summary matches should still be included");
  });

  it("keeps the summary matches, which are the whole point of searching them", () => {
    // No tool is named "speckle"; four SAR filters describe themselves that way.
    const hits = search("speckle");
    assert.ok(hits.includes("lee_filter"), hits.slice(0, 5).join(", "));
    assert.ok(hits.includes("frost_filter"), hits.slice(0, 5).join(", "));
  });

  it("orders name matches among themselves by catalog order, not by relevance", () => {
    // Deliberately not a ranking function: the dialog has always listed tools
    // in catalog order and this only separates the two kinds of hit. So
    // "slope" still leads with Average Flowpath Slope, as it always has.
    const named = CATALOG.filter((tool) => textOf(tool).name.toLowerCase().includes("hillshade"));
    assert.deepEqual(
      search("hillshade").slice(0, named.length),
      named.map((tool) => tool.id),
    );
  });

  it("drops tools that match neither", () => {
    assert.deepEqual(search("zzzznotatool"), []);
  });

  it("is case-insensitive and ignores surrounding space", () => {
    assert.deepEqual(search("  HILLSHADE "), search("hillshade"));
  });

  it("handles a tool with no summary at all", () => {
    // Five catalog entries have none; they must not throw or vanish from a
    // name search.
    const blank = CATALOG.filter((tool) => !tool.summary);
    assert.ok(blank.length > 0, "expected some tools without a summary");
    assert.ok(search(blank[0].id).includes(blank[0].id));
  });
});
