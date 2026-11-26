import { fireEvent, mockFetch, screen, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { DOMParser as LinkedomDOMParser } from "linkedom";
import { createElement } from "react";
import { renderAddDataSource } from "./helpers/add-data-shell";

const { WmsSource } =
  await import("../apps/geolibre-desktop/src/components/layout/add-data/sources/WmsSource");

// happy-dom's XML documents do not resolve getElementsByTagNameNS("*", ...),
// so the capabilities parser finds no layers there. Parse with linkedom, as
// tests/wms-capabilities-crs.test.ts does, and restore happy-dom's afterwards.
const happyDomParser = globalThis.DOMParser;
globalThis.DOMParser = LinkedomDOMParser as unknown as typeof globalThis.DOMParser;
after(() => {
  globalThis.DOMParser = happyDomParser;
});

const ENDPOINT = "https://maps.example.com/geoserver/wms";

const CAPABILITIES = `<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms">
  <Service><Name>WMS</Name><Title>Example</Title></Service>
  <Capability>
    <Request>
      <GetMap><Format>image/png</Format>
        <DCPType><HTTP><Get><OnlineResource xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="${ENDPOINT}?"/></Get></HTTP></DCPType>
      </GetMap>
    </Request>
    <Layer>
      <Title>Root</Title>
      <CRS>EPSG:3857</CRS>
      <CRS>EPSG:4326</CRS>
      <Layer queryable="1"><Name>topp:roads</Name><Title>Roads</Title></Layer>
      <Layer queryable="0"><Name>topp:rivers</Name><Title>Rivers</Title></Layer>
    </Layer>
  </Capability>
</WMS_Capabilities>`;

/** Render the source inside a minimal Add Data shell that records added layers. */
function renderSource(props: { initialUrl?: string; initialLayers?: string } = {}) {
  return renderAddDataSource(createElement(WmsSource, props));
}

/** Serve GetCapabilities (directly or through the dev proxy) and record requests. */
function serve(body: string, status = 200) {
  const requested: string[] = [];
  mockFetch(async (input) => {
    const raw = String(input);
    const proxied = raw.match(/[?&]url=([^&]+)/);
    requested.push(proxied ? decodeURIComponent(proxied[1]!) : raw);
    return new Response(body, { status, headers: { "Content-Type": "text/xml" } });
  });
  return requested;
}

const text = () => document.body.textContent ?? "";

describe("WmsSource", () => {
  it("retrieves the service's layers and adds the picked one as tiled GetMap requests", async () => {
    const requested = serve(CAPABILITIES);
    const { added, closed } = renderSource({ initialUrl: ENDPOINT });
    fireEvent.click(screen.getByRole("button", { name: "Retrieve layers" }));
    await waitFor(() => assert.ok(text().includes("Select from 2 layers"), text()));
    assert.match(requested[0]!, /REQUEST=GetCapabilities/i);
    assert.ok(text().includes("Roads (topp:roads)"));

    fireEvent.change(screen.getByLabelText("Retrieved layers"), {
      target: { value: "topp:rivers" },
    });
    assert.equal((screen.getByLabelText("Layers") as HTMLInputElement).value, "topp:rivers");
    fireEvent.click(screen.getByRole("button", { name: "Add layer" }));
    await waitFor(() => assert.equal(added.length, 1));
    const tiles = JSON.stringify(added[0]!.source);
    assert.match(tiles, /LAYERS=topp%3Arivers|LAYERS=topp:rivers/i);
    assert.match(tiles, /REQUEST=GetMap/i);
    assert.match(tiles, /VERSION=1\.3\.0/i);
    assert.equal(closed(), 1);
  });

  it("reports a service that lists no layers, and an unreachable one", async () => {
    serve(
      `<?xml version="1.0"?><WMS_Capabilities version="1.3.0"><Capability><Layer><Title>Empty</Title></Layer></Capability></WMS_Capabilities>`,
    );
    renderSource({ initialUrl: `${ENDPOINT}/empty` });
    fireEvent.click(screen.getByRole("button", { name: "Retrieve layers" }));
    await waitFor(() => assert.ok(text().includes("No layers were found for this service.")));
    serve("gateway down", 502);
    fireEvent.click(screen.getByRole("button", { name: "Retrieve layers" }));
    await waitFor(() => assert.ok(/502|Could not retrieve layers/.test(text())));
  });

  it("refuses to add without layer names", async () => {
    serve(CAPABILITIES);
    const { added } = renderSource({ initialUrl: `${ENDPOINT}/manual` });
    fireEvent.change(screen.getByLabelText("Layers"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Add layer" }));
    await waitFor(() => assert.ok(text().includes("Enter one or more WMS layer names.")));
    assert.equal(added.length, 0);
  });
});
