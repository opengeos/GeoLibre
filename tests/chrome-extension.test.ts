import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { scanDocumentForDatasets } from "../extensions/geolibre-chrome/scanner.mjs";
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
});
