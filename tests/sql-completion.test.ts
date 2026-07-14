import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  sqlCompletionCandidates,
  wordPrefixAt,
} from "../apps/geolibre-desktop/src/lib/sql-completion";
import type { SqlWorkspaceTableColumns } from "../apps/geolibre-desktop/src/lib/sql-workspace";

// Hand-built tables so the test stays free of the DuckDB-WASM import that
// sql-workspace.ts pulls in (it cannot load under the node test runner). The
// shape mirrors what previewLayerColumns produces for a loaded layer.
const tables: SqlWorkspaceTableColumns[] = [
  { tableName: "us_cities", columns: ["NAME", "POP", "geom"] },
];

describe("wordPrefixAt", () => {
  it("returns the identifier word before the cursor", () => {
    const text = "SELECT * FROM us_cit";
    assert.deepEqual(wordPrefixAt(text, text.length), {
      prefix: "us_cit",
      start: 14,
    });
  });

  it("returns an empty prefix when the cursor follows whitespace", () => {
    const text = "SELECT * FROM ";
    assert.deepEqual(wordPrefixAt(text, text.length), {
      prefix: "",
      start: text.length,
    });
  });
});

describe("sqlCompletionCandidates", () => {
  it("ranks table names before functions and keywords", () => {
    const candidates = sqlCompletionCandidates("us", tables);
    assert.equal(candidates[0], "us_cities");
  });

  it("matches case-insensitively and offers columns", () => {
    assert.ok(sqlCompletionCandidates("na", tables).includes("NAME"));
  });

  it("offers SQL keywords and ST_ functions on a prefix", () => {
    assert.ok(sqlCompletionCandidates("sel", tables).includes("SELECT"));
    assert.ok(sqlCompletionCandidates("st_ce", tables).includes("ST_Centroid"));
  });

  it("offers only tables and columns for an empty prefix", () => {
    const candidates = sqlCompletionCandidates("", tables);
    assert.ok(candidates.includes("us_cities"));
    assert.ok(candidates.includes("NAME"));
    assert.ok(!candidates.includes("SELECT"));
  });

  it("returns nothing when no candidate matches", () => {
    assert.deepEqual(sqlCompletionCandidates("zzz", tables), []);
  });
});
