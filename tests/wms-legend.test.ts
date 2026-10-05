import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DOMParser } from "linkedom";
import {
  findCapabilitiesLegendUrl,
  wmsGetLegendGraphicUrl,
  wmsLegendHtml,
  wmsLegendSource,
} from "../apps/geolibre-desktop/src/lib/wms-legend";
import { geojsonLayer } from "./helpers/layer-fixtures";

const wmsLayer = (source: Record<string, unknown>) =>
  geojsonLayer({
    id: "wms",
    type: "wms",
    geojson: undefined,
    source: { type: "raster", ...source },
  });

const CAPS = `<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms" xmlns:xlink="http://www.w3.org/1999/xlink">
<Capability><Layer><Title>root</Title>
<Layer><Name>dtm</Name><Style><Name>default</Name><LegendURL><OnlineResource xlink:href="https://wms.example/legend/default.png"/></LegendURL></Style>
<Style><Name>fancy</Name><LegendURL><OnlineResource xlink:href="https://wms.example/legend/fancy.png"/></LegendURL></Style></Layer>
<Layer><Name>bare</Name></Layer></Layer></Capability></WMS_Capabilities>`;

describe("WMS legend", () => {
  it("reads request fields from a WMS layer only", () => {
    const source = wmsLegendSource(
      wmsLayer({
        url: "https://wms.example/s?SERVICE=WMS",
        layers: "a, b",
        styles: "x",
        version: "1.3.0",
      }),
    );
    assert.deepEqual(source, {
      endpoint: "https://wms.example/s",
      layers: ["a", "b"],
      styles: ["x", ""],
      version: "1.3.0",
    });
    assert.equal(wmsLegendSource(wmsLayer({ url: "https://x/s", layers: "" })), null);
    assert.equal(
      wmsLegendSource({ ...wmsLayer({ url: "https://x/s", layers: "a" }), type: "xyz" }),
      null,
    );
  });

  it("builds a GetLegendGraphic URL", () => {
    const url = new URL(
      wmsGetLegendGraphicUrl(
        { endpoint: "https://wms.example/s", version: "1.1.1" },
        "dtm",
        "fancy",
      ),
    );
    assert.equal(url.searchParams.get("REQUEST"), "GetLegendGraphic");
    assert.equal(url.searchParams.get("LAYER"), "dtm");
    assert.equal(url.searchParams.get("STYLE"), "fancy");
    assert.equal(url.searchParams.get("FORMAT"), "image/png");
  });

  it("prefers the named style's LegendURL, then the first style", () => {
    const doc = new DOMParser().parseFromString(CAPS, "text/xml") as unknown as Document;
    assert.equal(
      findCapabilitiesLegendUrl(doc, "dtm", "fancy"),
      "https://wms.example/legend/fancy.png",
    );
    assert.equal(
      findCapabilitiesLegendUrl(doc, "dtm", ""),
      "https://wms.example/legend/default.png",
    );
    assert.equal(findCapabilitiesLegendUrl(doc, "bare", ""), null);
    assert.equal(findCapabilitiesLegendUrl(doc, "missing", ""), null);
  });

  it("builds escaped legend HTML, labelling layers only when there are several", () => {
    const one = wmsLegendHtml([{ layer: "dtm", url: 'https://x/s?a=1&b="2"' }]);
    assert.ok(one.includes('src="https://x/s?a=1&amp;b=&quot;2&quot;"'));
    assert.ok(!one.includes("font-weight"));
    const two = wmsLegendHtml([
      { layer: "a<b", url: "https://x/1" },
      { layer: "c", url: "https://x/2" },
    ]);
    assert.ok(two.includes("a&lt;b"));
    assert.equal(two.match(/<img /g)?.length, 2);
  });

  it("keeps styles paired with layers when a LAYERS entry is blank", () => {
    const source = wmsLegendSource(
      wmsLayer({ url: "https://x/s", layers: "a,,b", styles: "sa,,sb" }),
    );
    assert.deepEqual(source?.layers, ["a", "b"]);
    assert.deepEqual(source?.styles, ["sa", "sb"]);
  });

  it("resolves relative LegendURLs, rejects non-http(s) ones and keeps searching", () => {
    const caps = (href: string, second = "") =>
      new DOMParser().parseFromString(
        `<WMS_Capabilities xmlns="http://www.opengis.net/wms" xmlns:xlink="http://www.w3.org/1999/xlink"><Capability>
<Layer><Name>dtm</Name><Style><Name>d</Name><LegendURL><OnlineResource xlink:href="${href}"/></LegendURL></Style></Layer>${second}
</Capability></WMS_Capabilities>`,
        "text/xml",
      ) as unknown as Document;
    const base = "https://wms.example/geoserver/wms";
    assert.equal(
      findCapabilitiesLegendUrl(caps("/legend/dtm.png"), "dtm", "", base),
      "https://wms.example/legend/dtm.png",
    );
    assert.equal(findCapabilitiesLegendUrl(caps("javascript:alert(1)"), "dtm", "", base), null);
    assert.equal(
      findCapabilitiesLegendUrl(caps("data:image/png;base64,AA"), "dtm", "", base),
      null,
    );
    const twice = caps(
      "",
      '<Layer><Name>dtm</Name><Style><Name>d</Name><LegendURL><OnlineResource xlink:href="https://wms.example/second.png"/></LegendURL></Style></Layer>',
    );
    assert.equal(
      findCapabilitiesLegendUrl(twice, "dtm", "", base),
      "https://wms.example/second.png",
    );
  });
});
