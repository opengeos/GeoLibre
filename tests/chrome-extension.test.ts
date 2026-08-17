import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { scanDocumentForDatasets } from "../extensions/geolibre-chrome/scanner.mjs";
import {
  classifyServiceRequest,
  classifyStyleRequest,
  createPageScope,
  createTabTaskQueue,
  mergeServiceCandidates,
} from "../extensions/geolibre-chrome/service-scanner.mjs";
import { buildGeoLibreUrl } from "../extensions/geolibre-chrome/url-builder.mjs";

function scan(html: string, url = "https://catalog.example.com/page/") {
  const { document } = parseHTML(html);
  Object.defineProperty(document, "baseURI", { configurable: true, value: url });
  const previous = globalThis.document;
  Object.assign(globalThis, { document });
  try {
    return scanDocumentForDatasets();
  } finally {
    Object.assign(globalThis, { document: previous });
  }
}

describe("GeoLibre Chrome extension scanner", () => {
  it("finds supported absolute and relative dataset links", () => {
    assert.deepEqual(
      scan(`
        <a href="roads.geojson">Road network</a>
        <a href="https://data.example.com/dem.tif">Elevation</a>
        <a href="notes.pdf">Notes</a>
      `),
      [
        {
          url: "https://data.example.com/dem.tif",
          name: "Elevation",
          format: "GeoTIFF",
          kind: "raster",
          styleUrl: null,
        },
        {
          url: "https://catalog.example.com/page/roads.geojson",
          name: "Road network",
          format: "GeoJSON",
          kind: "vector",
          styleUrl: null,
        },
      ],
    );
  });

  it("reads extensionless downloads from JSON-LD metadata", () => {
    const found = scan(`
      <script type="application/ld+json">
        {"@type":"DataDownload","name":"County boundaries","encodingFormat":"application/geo+json","contentUrl":"https://api.example.com/export?id=7"}
      </script>
    `);
    assert.deepEqual(found, [
      {
        url: "https://api.example.com/export?id=7",
        name: "County boundaries",
        format: "GeoJSON",
        kind: "vector",
        styleUrl: null,
      },
    ]);
  });

  it("keeps generic JSON links only when their page context identifies spatial data", () => {
    const found = scan(`
      <a href="package.json">package.json</a>
      <a href="roads.json" title="Vector dataset">Download roads</a>
    `);
    assert.deepEqual(found, [
      {
        url: "https://catalog.example.com/page/roads.json",
        name: "Download roads",
        format: "JSON",
        kind: "vector",
        styleUrl: null,
      },
    ]);
  });

  it("does not read a documentation link's wording as a dataset", () => {
    assert.deepEqual(
      scan(
        `
          <a href="https://maplibre.org/docs/examples/add-a-geojson-line/">Add a GeoJSON line</a>
          <a href="https://maplibre.org/docs/examples/cog-raster-source.html">Add a COG raster source</a>
          <a href="https://api.example.com/export?id=7" title="GeoJSON">County boundaries</a>
          <a href="https://api.example.com/datasets/123/" title="GeoJSON">Elevation extract</a>
        `,
        "https://maplibre.org/docs/examples/",
      ),
      // The trailing-slash REST endpoint keeps its hint: only a slug the link
      // text reads back marks a URL as a page about the format.
      [
        {
          url: "https://api.example.com/export?id=7",
          name: "County boundaries",
          format: "GeoJSON",
          kind: "vector",
          styleUrl: null,
        },
        {
          url: "https://api.example.com/datasets/123/",
          name: "Elevation extract",
          format: "GeoJSON",
          kind: "vector",
          styleUrl: null,
        },
      ],
    );
  });

  it("pairs a neighboring style by filename stem", () => {
    const [found] = scan(`
      <a href="roads.geojson">roads.geojson</a>
      <a href="roads.geolibre.style.json">Road style</a>
    `);
    assert.equal(found.styleUrl, "https://catalog.example.com/page/roads.geolibre.style.json");
  });

  it("canonicalizes Source Cooperative dataset and style URLs", () => {
    const [found] = scan(
      `
        <a href="https://source.coop/giswqs/opengeos/roads.geojson">roads.geojson</a>
        <a href="https://source.coop/giswqs/opengeos/roads.style.json">Road style</a>
      `,
      "https://source.coop/giswqs/opengeos",
    );
    assert.equal(found.url, "https://data.source.coop/giswqs/opengeos/roads.geojson");
    assert.equal(found.styleUrl, "https://data.source.coop/giswqs/opengeos/roads.style.json");
  });

  it("collapses every Hugging Face file route onto the direct resolve URL", () => {
    const repo = "https://huggingface.co/datasets/giswqs/PACE-Water-Quality";
    const file = "main/cogs/PACE_OCI-20260103-chla.tif";
    const found = scan(
      `
        <a href="${repo}/blob/${file}">PACE_OCI-20260103-chla.tif</a>
        <a href="${repo}/raw/${file}">Raw pointer file</a>
        <a href="${repo}/blame/${file}">Blame</a>
        <a href="${repo}/edit/${file}">Contribute</a>
        <a href="${repo}/delete/${file}">Delete</a>
        <a href="${repo}/commits/${file}">History</a>
        <a href="${repo}/resolve/${file}?download=true">Download</a>
      `,
      `${repo}/blob/${file}`,
    );
    assert.deepEqual(found, [
      {
        url: `${repo}/resolve/${file}`,
        name: "PACE_OCI-20260103-chla.tif",
        format: "GeoTIFF",
        kind: "raster",
        styleUrl: null,
      },
    ]);
  });

  it("canonicalizes Hugging Face model and Space files but leaves other Hub links alone", () => {
    const found = scan(
      `
        <a href="https://hf.co/giswqs/model/blob/main/grid.geojson">grid</a>
        <a href="https://huggingface.co/spaces/giswqs/demo/blob/main/roads.pmtiles">roads</a>
        <a href="https://huggingface.co/datasets/giswqs/PACE-Water-Quality/tree/main/cogs">cogs</a>
        <a href="https://huggingface.co/datasets/giswqs/PACE-Water-Quality/tree/refs%2Fconvert%2Fparquet/default">Auto-converted to Parquet</a>
      `,
      "https://huggingface.co/giswqs",
    );
    assert.deepEqual(
      found.map((dataset) => dataset.url),
      [
        "https://hf.co/giswqs/model/resolve/main/grid.geojson",
        "https://huggingface.co/spaces/giswqs/demo/resolve/main/roads.pmtiles",
      ],
    );
  });

  it("reads the Hugging Face route from its position, not the first matching segment", () => {
    const found = scan(
      `
        <a href="https://huggingface.co/datasets/giswqs/blob/resolve/main/roads.geojson">repo named blob</a>
        <a href="https://huggingface.co/raw/model/blob/main/dem.tif">owner named raw</a>
        <a href="https://huggingface.co/datasets/glue/blob/main/grid.pmtiles">legacy repo</a>
      `,
      "https://huggingface.co/giswqs",
    );
    assert.deepEqual(
      found.map((dataset) => dataset.url),
      [
        "https://huggingface.co/raw/model/resolve/main/dem.tif",
        "https://huggingface.co/datasets/glue/resolve/main/grid.pmtiles",
        "https://huggingface.co/datasets/giswqs/blob/resolve/main/roads.geojson",
      ],
    );
  });

  it("falls back to a shallower Hugging Face route when the deeper one cannot parse", () => {
    const found = scan(
      `
        <a href="https://huggingface.co/gpt2/blob/main/grid.geojson">namespaceless model</a>
        <a href="https://huggingface.co/datasets/glue/blob/resolve/legacy.tif">revision named resolve</a>
      `,
      "https://huggingface.co/gpt2",
    );
    assert.deepEqual(
      found.map((dataset) => dataset.url),
      [
        "https://huggingface.co/gpt2/resolve/main/grid.geojson",
        "https://huggingface.co/datasets/glue/resolve/resolve/legacy.tif",
      ],
    );
  });

  it("drops a Hugging Face line anchor so it does not split one file in two", () => {
    const repo = "https://huggingface.co/datasets/giswqs/opengeos";
    const found = scan(
      `
        <a href="${repo}/blob/main/roads.geojson#L10">roads</a>
        <a href="${repo}/resolve/main/roads.geojson?download=true">Download</a>
      `,
      `${repo}/tree/main`,
    );
    assert.deepEqual(
      found.map((dataset) => dataset.url),
      [`${repo}/resolve/main/roads.geojson`],
    );
  });

  it("pairs a Hugging Face style file with its dataset across routes", () => {
    const repo = "https://huggingface.co/datasets/giswqs/opengeos";
    const [found] = scan(
      `
        <a href="${repo}/resolve/main/roads.geojson?download=true">Download</a>
        <a href="${repo}/blob/main/roads.style.json">roads.style.json</a>
      `,
      `${repo}/tree/main`,
    );
    assert.equal(found.url, `${repo}/resolve/main/roads.geojson`);
    assert.equal(found.styleUrl, `${repo}/resolve/main/roads.style.json`);
  });

  it("preserves a discovered style when stronger metadata replaces a dataset", () => {
    const target = new URL("https://web.geolibre.app/");
    target.searchParams.append("data", "https://data.example.com/roads.json");
    target.searchParams.append("style", "https://data.example.com/roads.style.json");
    const [found] = scan(`
      <a href="${target.href}" title="Spatial dataset">Open map</a>
      <script type="application/ld+json">
        {"@type":"DataDownload","name":"Roads","encodingFormat":"application/geo+json","contentUrl":"https://data.example.com/roads.json"}
      </script>
    `);
    assert.equal(found.format, "GeoJSON");
    assert.equal(found.styleUrl, "https://data.example.com/roads.style.json");
  });

  it("unpacks data and positional styles from existing GeoLibre links", () => {
    const target = new URL("https://web.geolibre.app/");
    target.searchParams.append("data", "https://data.example.com/roads.geojson");
    target.searchParams.append("data", "https://data.example.com/dem.tif");
    target.searchParams.append("style", "");
    target.searchParams.append("style", "https://data.example.com/dem.style.json");
    const found = scan(`<a href="${target.href}">Open map</a>`);
    assert.equal(found.length, 2);
    assert.equal(
      found.find((dataset) => dataset.url.endsWith("roads.geojson"))?.name,
      "roads.geojson",
    );
    assert.equal(
      found.find((dataset) => dataset.url.endsWith("dem.tif"))?.styleUrl,
      "https://data.example.com/dem.style.json",
    );
  });

  it("deduplicates repeated links", () => {
    const found = scan(`
      <a href="roads.pmtiles">Roads</a>
      <a href="roads.pmtiles">Download roads</a>
    `);
    assert.equal(found.length, 1);
  });

  it("reads Source Cooperative's complete virtualized inventory and canonicalizes duplicates", () => {
    const found = scan(
      `
        <a href="https://source.coop/giswqs/opengeos/roads.geojson">roads.geojson</a>
        <a href="https://data.source.coop/giswqs/opengeos/roads.geojson"></a>
        <script>window.unrelated = '{\\"path\\":\\"fake.tif\\",\\"type\\":\\"file\\"}'</script>
        <script>self.__next_f.push([1,"{\\"objects\\":[{\\"path\\":\\"roads.geojson\\",\\"type\\":\\"file\\"},{\\"type\\":\\"file\\",\\"path\\":\\"dem.tif\\"},{\\"path\\":\\"notes.txt\\",\\"type\\":\\"file\\"}]}"])</script>
      `,
      "https://source.coop/giswqs/opengeos",
    );
    assert.deepEqual(
      found.map((dataset) => ({ url: dataset.url, kind: dataset.kind })),
      [
        { url: "https://data.source.coop/giswqs/opengeos/dem.tif", kind: "raster" },
        { url: "https://data.source.coop/giswqs/opengeos/roads.geojson", kind: "vector" },
      ],
    );
  });
});

describe("GeoLibre Chrome extension URL builder", () => {
  it("builds repeated data and positional style parameters", () => {
    const result = new URL(
      buildGeoLibreUrl([
        { url: "https://data.example.com/roads.geojson", styleUrl: null },
        {
          url: "https://data.example.com/dem.tif?version=2",
          styleUrl: "https://data.example.com/dem.style.json",
        },
      ]),
    );
    assert.deepEqual(result.searchParams.getAll("data"), [
      "https://data.example.com/roads.geojson",
      "https://data.example.com/dem.tif?version=2",
    ]);
    assert.deepEqual(result.searchParams.getAll("style"), [
      "",
      "https://data.example.com/dem.style.json",
    ]);
  });

  it("omits style parameters when no selected dataset has a style", () => {
    const result = new URL(buildGeoLibreUrl([{ url: "https://data.example.com/roads.geojson" }]));
    assert.equal(result.searchParams.has("style"), false);
  });

  it("rejects an empty selection and non-web URLs", () => {
    assert.throws(() => buildGeoLibreUrl([]), /Select at least one/);
    assert.throws(() => buildGeoLibreUrl([{ url: "file:///tmp/roads.geojson" }]), /HTTP or HTTPS/);
  });

  it("tells a mixed selection apart from two services", () => {
    const service = { url: "https://maps.example.com/wms", format: "WMS" };
    assert.throws(
      () => buildGeoLibreUrl([service, { url: "https://maps.example.com/wfs", format: "WFS" }]),
      /one map service at a time/,
    );
    assert.throws(
      () => buildGeoLibreUrl([service, { url: "https://data.example.com/roads.geojson" }]),
      /cannot be opened together with other data/,
    );
  });

  it("routes detected services to the matching prefilled Add Data dialog", () => {
    const result = new URL(
      buildGeoLibreUrl([
        {
          url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
          format: "XYZ / TMS",
        },
      ]),
    );
    assert.equal(result.searchParams.get("add"), "xyz");
    assert.equal(
      result.searchParams.get("serviceUrl"),
      "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    );
    assert.equal(result.searchParams.has("data"), false);
  });

  it("hands over the layer and style a service needs to be addable", () => {
    const result = new URL(
      buildGeoLibreUrl([
        {
          url: "https://tiles.example.com/{z}/{x}/{y}.pbf",
          format: "Vector tiles",
          layer: "water",
          styleUrl: "https://tiles.example.com/style.json",
        },
      ]),
    );
    assert.equal(result.searchParams.get("serviceLayer"), "water");
    assert.equal(result.searchParams.get("serviceStyle"), "https://tiles.example.com/style.json");
    // Nothing extra when the service was not asked for a specific layer.
    const bare = new URL(
      buildGeoLibreUrl([{ url: "https://maps.example.com/wms", format: "WMS" }]),
    );
    assert.equal(bare.searchParams.has("serviceLayer"), false);
    assert.equal(bare.searchParams.has("serviceStyle"), false);
  });
});

describe("GeoLibre Chrome extension service request scanner", () => {
  it("recognizes OGC web services and removes operation parameters", () => {
    const cases = [
      ["WMS", "GetMap", "WMS", "raster"],
      ["WMTS", "GetCapabilities", "WMTS", "raster"],
      ["WFS", "GetFeature", "WFS", "vector"],
    ];
    for (const [service, request, format, kind] of cases) {
      const found = classifyServiceRequest(
        `https://maps.example.com/ows?token=keep&SERVICE=${service}&REQUEST=${request}&BBOX=1,2,3,4`,
      );
      assert.equal(found?.url, "https://maps.example.com/ows?token=keep");
      assert.equal(found?.format, format);
      assert.equal(found?.kind, kind);
    }
  });

  it("carries the layer each service was asked for", () => {
    assert.equal(
      classifyServiceRequest(
        "https://maps.example.com/wms?SERVICE=WMS&REQUEST=GetMap&LAYERS=topp:states&BBOX=1,2,3,4",
      )?.layer,
      "topp:states",
    );
    // A WFS request names its feature type and encoding beside the operation;
    // both belong in the form's own fields, not in the endpoint.
    const wfs = classifyServiceRequest(
      "https://maps.example.com/wfs?service=WFS&request=GetFeature&typename=osm:water_areas&outputFormat=application/json&srsname=EPSG:3857&key=keep",
    );
    assert.equal(wfs?.url, "https://maps.example.com/wfs?key=keep");
    assert.equal(wfs?.layer, "osm:water_areas");
    assert.equal(
      classifyServiceRequest(
        "https://maps.example.com/wfs?service=WFS&request=GetFeature&TYPENAMES=ns:roads",
      )?.layer,
      "ns:roads",
    );
  });

  it("rewrites a WMTS tile request into the template that produced it", () => {
    const tile = classifyServiceRequest(
      "https://maps.example.com/wmts?layer=sgmc2&style=default&tilematrixset=GoogleMapsCompatible&Service=WMTS&Request=GetTile&Format=image/png&TileMatrix=4&TileCol=9&TileRow=7",
    );
    assert.equal(tile?.layer, "sgmc2");
    assert.match(tile?.url ?? "", /TileMatrix=\{z\}/);
    assert.match(tile?.url ?? "", /TileCol=\{x\}/);
    assert.match(tile?.url ?? "", /TileRow=\{y\}/);
    // A capabilities request names no tile, so it stays the plain endpoint.
    assert.equal(
      classifyServiceRequest("https://maps.example.com/wmts?SERVICE=WMTS&REQUEST=GetCapabilities")
        ?.url,
      "https://maps.example.com/wmts",
    );
  });

  it("recognizes the style document a vector tileset renders through", () => {
    assert.deepEqual(classifyStyleRequest("https://tiles.example.com/style.json"), {
      origin: "https://tiles.example.com",
      url: "https://tiles.example.com/style.json",
    });
    assert.equal(
      classifyStyleRequest("https://api.example.com/maps/streets/style.json?key=abc")?.url,
      "https://api.example.com/maps/streets/style.json?key=abc",
    );
    assert.ok(
      classifyStyleRequest("https://tiles.example.com/VectorTileServer/resources/styles/root.json"),
    );
    assert.equal(classifyStyleRequest("https://example.com/data/roads.json"), null);
    assert.equal(classifyStyleRequest("https://example.com/style.json.txt"), null);
  });

  it("recognizes OGC API Features and ArcGIS feature service requests", () => {
    assert.equal(
      classifyServiceRequest("https://api.example.com/ogc/collections/roads/items?f=json")?.format,
      "OGC API",
    );
    // A bare `/collections` is an ordinary storefront and REST route too, so it
    // counts only alongside an OGC format parameter.
    assert.equal(
      classifyServiceRequest("https://api.example.com/ogc/collections?f=json")?.format,
      "OGC API",
    );
    assert.equal(classifyServiceRequest("https://shop.example.com/collections"), null);
    assert.equal(classifyServiceRequest("https://shop.example.com/collections?page=2"), null);
    // The layer index stays on the URL: handed a bare service, GeoLibre falls
    // back to its first feature layer, which is the wrong one for any page
    // showing another.
    const sublayer = classifyServiceRequest(
      "https://services.example.com/arcgis/rest/services/Roads/FeatureServer/2/query?f=geojson",
    );
    assert.equal(
      sublayer?.url,
      "https://services.example.com/arcgis/rest/services/Roads/FeatureServer/2",
    );
    assert.equal(sublayer?.layer, "2");
    const service = classifyServiceRequest(
      "https://services.example.com/arcgis/rest/services/Roads/FeatureServer",
    );
    assert.equal(
      service?.url,
      "https://services.example.com/arcgis/rest/services/Roads/FeatureServer",
    );
    assert.equal(service?.layer, null);
  });

  it("turns raster and vector tile coordinates into reusable templates", () => {
    const raster = classifyServiceRequest("https://tiles.example.com/base/6/17/25.png?key=abc");
    assert.equal(raster?.url, "https://tiles.example.com/base/{z}/{x}/{y}.png?key=abc");
    assert.equal(raster?.format, "XYZ / TMS");
    const vector = classifyServiceRequest("https://tiles.example.com/roads/6/17/25.pbf");
    assert.equal(vector?.format, "Vector tiles");
    assert.equal(vector?.kind, "vector");
  });

  it("does not mistake a style's glyph ranges for a vector tile service", () => {
    assert.equal(
      classifyServiceRequest(
        "https://demotiles.maplibre.org/font/Open%20Sans%20Semibold/0-255.pbf",
      ),
      null,
    );
    assert.equal(classifyServiceRequest("https://tiles.example.com/fonts/Roboto/0-255.pbf"), null);
    // A tileset that carries its coordinates in the query string still counts.
    assert.equal(
      classifyServiceRequest("https://tiles.example.com/roads.pbf?x=17&y=25&z=6")?.format,
      "Vector tiles",
    );
  });

  it("does not mistake date-organized assets for map tiles", () => {
    assert.equal(classifyServiceRequest("https://cdn.example.com/uploads/2024/03/15.png"), null);
    assert.equal(classifyServiceRequest("https://cdn.example.com/items/4/17/25.png"), null);
  });

  it("ignores ordinary requests and deduplicates services", () => {
    assert.equal(classifyServiceRequest("https://example.com/app.js"), null);
    const service = classifyServiceRequest(
      "https://maps.example.com/wms?service=WMS&request=GetCapabilities",
    );
    assert.deepEqual(mergeServiceCandidates([service], [service]), [service]);
  });

  it("keeps two layers of one service apart despite their shared endpoint", () => {
    const roads = classifyServiceRequest(
      "https://maps.example.com/wms?service=WMS&request=GetMap&layers=roads",
    );
    const rivers = classifyServiceRequest(
      "https://maps.example.com/wms?service=WMS&request=GetMap&layers=rivers",
    );
    assert.equal(roads?.url, rivers?.url);
    assert.deepEqual(mergeServiceCandidates([roads, rivers], [roads]), [roads, rivers]);
  });

  it("deduplicates WMTS requests with different tile coordinates", () => {
    const first = classifyServiceRequest(
      "https://maps.example.com/wmts?SERVICE=WMTS&REQUEST=GetTile&LAYER=roads&TILEMATRIXSET=web&TILEMATRIX=4&TILEROW=7&TILECOL=9",
    );
    const second = classifyServiceRequest(
      "https://maps.example.com/wmts?SERVICE=WMTS&REQUEST=GetTile&LAYER=roads&TILEMATRIXSET=web&TILEMATRIX=4&TILEROW=8&TILECOL=10",
    );
    assert.ok(first && second);
    assert.equal(first.url, second.url);
  });

  it("serializes asynchronous work independently per tab", async () => {
    const enqueue = createTabTaskQueue();
    const order: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = enqueue(7, async () => {
      order.push("first:start");
      await blocked;
      order.push("first:end");
    });
    const second = enqueue(7, async () => {
      order.push("second");
    });
    const other = enqueue(8, async () => {
      order.push("other");
    });
    await other;
    assert.deepEqual(order, ["first:start", "other"]);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first:start", "other", "first:end", "second"]);
  });

  it("accepts the documents of the current page, including frames it opens later", () => {
    const scope = createPageScope();
    scope.startPage(7);
    // Chrome sends no documentId on the navigation itself; the ids arrive on
    // the requests the page then makes, the top document and its frames alike.
    assert.equal(scope.accepts(7, undefined), true);
    assert.equal(scope.accepts(7, "top-document"), true);
    assert.equal(scope.accepts(7, "child-document"), true);
  });

  it("keeps a document the incoming page created before its own navigation finished", () => {
    const scope = createPageScope();
    scope.startPage(4);
    scope.accepts(4, "old-document");
    // A tile the next page requests can complete before that page's HTML does,
    // so the boundary is drawn when the navigation starts.
    scope.beginPage(4);
    assert.equal(scope.accepts(4, "new-document"), true);
    scope.startPage(4);
    assert.equal(scope.accepts(4, "new-document"), true);
    assert.equal(scope.accepts(4, "old-document"), false);
  });

  it("retires an outgoing document even if it reports in mid-navigation", () => {
    const scope = createPageScope();
    scope.startPage(6);
    scope.accepts(6, "old-document");
    scope.beginPage(6);
    // Still the page on screen, so the request counts, but the document must
    // not escape retirement by reporting during the transition.
    assert.equal(scope.accepts(6, "old-document"), true);
    scope.startPage(6);
    assert.equal(scope.accepts(6, "old-document"), false);
  });

  it("refuses a request left in flight by the page that was navigated away from", () => {
    const scope = createPageScope();
    scope.startPage(3);
    assert.equal(scope.accepts(3, "old-document"), true);
    scope.startPage(3);
    assert.equal(scope.accepts(3, "old-document"), false);
    assert.equal(scope.accepts(3, "new-document"), true);
    // A second navigation retires the page between, not only the first one.
    scope.startPage(3);
    assert.equal(scope.accepts(3, "new-document"), false);
  });

  it("scopes documents and generations to their own tab", () => {
    const scope = createPageScope();
    scope.startPage(1);
    scope.accepts(1, "shared-id");
    const generation = scope.generation(1);
    scope.startPage(2);
    assert.equal(scope.generation(1), generation);
    assert.equal(scope.accepts(2, "shared-id"), true);
    scope.startPage(1);
    assert.notEqual(scope.generation(1), generation);
    assert.equal(scope.accepts(1, "shared-id"), false);
    assert.equal(scope.accepts(2, "shared-id"), true);
  });

  it("forgets a closed tab rather than growing a set per tab that ever existed", () => {
    const scope = createPageScope();
    scope.startPage(9);
    scope.accepts(9, "document");
    scope.startPage(9);
    assert.equal(scope.accepts(9, "document"), false);
    scope.forget(9);
    assert.equal(scope.generation(9), 0);
    assert.equal(scope.accepts(9, "document"), true);
  });
});

describe("GeoLibre Chrome extension request watcher", () => {
  interface Details {
    tabId?: number;
    type?: string;
    url: string;
    documentId?: string;
  }
  type Listener = (details: Details) => void;

  // `background.mjs` registers its listeners against the extension APIs at
  // import time, so the module is exercised through a stub of them.
  async function loadWatcher() {
    const store = new Map<string, unknown>();
    const completed: Listener[] = [];
    const navigations: Listener[] = [];
    let writes = 0;
    const addListener = (list: Listener[]) => (fn: Listener) => list.push(fn);
    Object.assign(globalThis, {
      chrome: {
        webRequest: {
          onCompleted: { addListener: addListener(completed) },
          onBeforeRequest: { addListener: addListener(navigations) },
        },
        tabs: { onRemoved: { addListener: () => undefined } },
        storage: {
          session: {
            get: async (key: string) => ({ [key]: store.get(key) }),
            set: async (items: Record<string, unknown>) => {
              writes += 1;
              for (const [name, value] of Object.entries(items)) store.set(name, value);
            },
            remove: async (key: string) => {
              store.delete(key);
            },
          },
        },
      },
    });
    await import("../extensions/geolibre-chrome/background.mjs");
    const settle = async () => {
      for (let turn = 0; turn < 8; turn += 1) await new Promise((r) => setTimeout(r, 0));
    };
    return {
      services: () => (store.get("services:1") ?? []) as { url: string; styleUrl: string | null }[],
      writes: () => writes,
      async request(details: Details) {
        const event = { tabId: 1, type: "xmlhttprequest", documentId: "doc", ...details };
        if (event.type === "main_frame") for (const fn of navigations) fn(event);
        for (const fn of completed) fn(event);
        await settle();
      },
    };
  }

  it("fills in a style that arrives after the tiles it describes", async () => {
    const watcher = await loadWatcher();
    await watcher.request({ type: "main_frame", url: "https://maps.example.com/", documentId: "" });
    await watcher.request({ url: "https://tiles.example.com/roads/4/5/6.pbf" });
    assert.deepEqual(
      watcher.services().map((entry) => entry.styleUrl),
      [null],
    );
    // The style is a separate request and can finish after the first tile.
    await watcher.request({ url: "https://tiles.example.com/style.json" });
    assert.deepEqual(
      watcher.services().map((entry) => entry.styleUrl),
      ["https://tiles.example.com/style.json"],
    );

    // Panning a map repeats one candidate; that must not keep rewriting it.
    const before = watcher.writes();
    await watcher.request({ url: "https://tiles.example.com/roads/7/8/9.pbf" });
    await watcher.request({ url: "https://tiles.example.com/roads/1/2/3.pbf" });
    assert.equal(watcher.writes(), before);
    assert.equal(watcher.services().length, 1);
  });
});
