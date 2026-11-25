import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { parseProject, serializeProject } from "@geolibre/core";
import {
  getSqlQueryLayerConfig,
  isSqlQueryLayer,
  sourceLayersForQueryRefresh,
} from "../apps/geolibre-desktop/src/lib/sql-query-layer";
import { isRefreshableLayer } from "../apps/geolibre-desktop/src/lib/layer-refresh";

it("restores a Python SQL snapshot with the app's refreshable query contract", () => {
  const project = parseProject(
    readFileSync(new URL("./fixtures/python-sql-query.geolibre.json", import.meta.url), "utf8"),
  );
  const query = project.layers.find((layer) => layer.id === "query");
  assert.ok(query);
  assert.equal(isSqlQueryLayer(query), true);
  assert.equal(isRefreshableLayer(query), true);
  assert.deepEqual(getSqlQueryLayerConfig(query), {
    engine: "duckdb",
    sql: "SELECT name, geom FROM cities WHERE pop >= 50",
  });
  assert.equal(query.geojson?.features.length, 1);
  assert.equal(query.geojson?.features[0].properties?.name, "B");
  assert.equal(query.style.circleRadius, 9);
  assert.equal(query.sourcePath, undefined);
  assert.deepEqual(
    sourceLayersForQueryRefresh(query, project.layers).map((layer) => layer.name),
    ["cities"],
  );
  const restored = parseProject(serializeProject(project));
  assert.deepEqual(restored.layers.find((layer) => layer.id === "query")?.metadata, query.metadata);
});
