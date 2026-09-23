import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { collectQueryDataSources } from "../apps/geolibre-desktop/src/lib/sql-data-sources";

// Real `json_serialize_sql` output from DuckDB-WASM for each query below, so
// the walker is checked against the parser's actual tree shape.
const ASTS = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/duckdb-sql-ast.json", import.meta.url)), "utf8"),
) as Record<string, unknown>;

function sourcesOf(sql: string): string[] {
  assert.ok(sql in ASTS, `no fixture AST for: ${sql}`);
  return collectQueryDataSources(ASTS[sql]);
}

describe("collectQueryDataSources (issue #2582)", () => {
  it("finds no data source when geometry is written into the SQL", () => {
    for (const sql of [
      "SELECT 1 AS x, ST_GeomFromText('POINT(100 13)') AS geometry",
      "SELECT * FROM (SELECT 1 AS x, ST_GeomFromText('POINT(100 13)') AS geometry) t",
      "SELECT * FROM (VALUES (1, 'POINT(0 0)')) v(id, wkt)",
      "SELECT ST_Point(i, i) AS g FROM range(5) r(i)",
      "WITH pts AS (SELECT ST_Point(1, 2) AS g) SELECT * FROM pts",
    ]) {
      assert.deepEqual(sourcesOf(sql), [], sql);
    }
  });

  it("finds tables and readers wherever the query reads them", () => {
    assert.deepEqual(sourcesOf("SELECT name, geom FROM Cities"), ["Cities"]);
    assert.deepEqual(
      sourcesOf("WITH big AS (SELECT * FROM cities WHERE pop > 1) SELECT * FROM big"),
      ["cities"],
    );
    assert.deepEqual(sourcesOf("SELECT (SELECT geom FROM countries LIMIT 1) AS g"), ["countries"]);
    assert.deepEqual(sourcesOf("SELECT ST_Buffer(geom, 1) AS g FROM read_parquet('x.parquet')"), [
      "read_parquet",
    ]);
    assert.deepEqual(sourcesOf("SELECT ST_Point(0,0) AS g UNION ALL SELECT geom FROM cities"), [
      "cities",
    ]);
  });

  it("scopes a CTE to the query that defines it", () => {
    // A same-named CTE elsewhere in the statement must not hide a real read.
    assert.deepEqual(
      sourcesOf(
        "SELECT * FROM us_cities UNION ALL SELECT * FROM (WITH us_cities AS (SELECT ST_Point(0,0) AS g) SELECT * FROM us_cities) x",
      ),
      ["us_cities"],
    );
    assert.deepEqual(
      sourcesOf(
        "SELECT geom FROM cities WHERE EXISTS (WITH cities AS (SELECT 1) SELECT * FROM cities)",
      ),
      ["cities"],
    );
    // A non-recursive CTE body naming itself reads the real table.
    assert.deepEqual(sourcesOf("WITH cities AS (SELECT * FROM cities) SELECT * FROM cities"), [
      "cities",
    ]);
    // Later CTEs see earlier ones, and a recursive CTE sees itself.
    assert.deepEqual(
      sourcesOf("WITH a AS (SELECT ST_Point(1, 2) AS g), b AS (SELECT * FROM a) SELECT * FROM b"),
      [],
    );
    assert.deepEqual(
      sourcesOf(
        "WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 3) SELECT ST_Point(n, n) AS g FROM t",
      ),
      [],
    );
  });

  it("treats identifiers as case-insensitive when de-duplicating", () => {
    assert.deepEqual(sourcesOf("SELECT a.geom FROM Cities a JOIN cities b ON true"), ["Cities"]);
  });

  it("tolerates input that is not a parse tree", () => {
    assert.deepEqual(collectQueryDataSources(null), []);
    assert.deepEqual(collectQueryDataSources({ statements: "nope" }), []);
  });
});
