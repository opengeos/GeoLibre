import "./helpers/dom";
import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelStacCatalogRequest,
  consumeStacCatalogRequest,
  requestStacCatalogUrl,
} from "../packages/plugins/src/stac-catalog-request";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

test("a pre-import STAC request survives sibling activation, is consumed once, and supports reopening", async () => {
  const url = "https://planetarycomputer.microsoft.com/api/stac/v1/collections/sentinel-2-l2a";
  requestStacCatalogUrl(url);
  const native = await import("../packages/plugins/src/plugins/maplibre-stac");
  assert.equal(native.requestStacCatalogUrl, requestStacCatalogUrl);
  assert.equal(native.cancelStacCatalogRequest, cancelStacCatalogRequest);
  const opened: string[] = [];
  const app = {
    getMap: () => null,
    getControlMap: () => null,
    openRightPanel: (id: string) => opened.push(id),
    closeRightPanel: () => {},
  } as unknown as GeoLibreAppAPI;
  await native.maplibrePlanetOpenDataPlugin.activate(app);
  assert.equal(consumeStacCatalogRequest(), url, "a sibling preset must not consume the request");
  requestStacCatalogUrl(url);
  await native.maplibrePlanetOpenDataPlugin.deactivate(app);
  await native.maplibreStacCatalogsPlugin.activate(app);
  assert.equal(consumeStacCatalogRequest(), "", "STAC consumes the request on activation");
  const before = opened.length;
  requestStacCatalogUrl(url);
  assert.equal(opened.length, before + 1, "an active browser reopens its closed panel");
  assert.equal(consumeStacCatalogRequest(), "");
  await native.maplibreStacCatalogsPlugin.deactivate(app);
  requestStacCatalogUrl(url);
  cancelStacCatalogRequest();
  assert.equal(consumeStacCatalogRequest(), "", "failed activation cannot leak a one-time URL");
});
