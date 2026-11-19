import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zlibSync } from "fflate";
import proj4 from "proj4";
import { geoPdfCrsConverters } from "../apps/geolibre-desktop/src/lib/geopdf/crs";
import {
  applyUserToCrs,
  fitViewportTransform,
  primaryViewport,
  readGeoPdfPages,
  viewportsByArea,
  wktEpsg,
} from "../apps/geolibre-desktop/src/lib/geopdf/georef";
import {
  boundedInflate,
  PdfDocument,
  PdfReadError,
} from "../apps/geolibre-desktop/src/lib/geopdf/pdf-objects";
import {
  handOffDroppedPdfs,
  isPdfFileName,
  subscribePendingGeoPdf,
  takePendingGeoPdf,
} from "../apps/geolibre-desktop/src/lib/geopdf/pending";
import {
  isAffineInMercator,
  lngLatToMercator,
  mercatorToLngLat,
  planMercatorWarp,
  warpCorners,
  warpToMercator,
} from "../apps/geolibre-desktop/src/lib/geopdf/warp";

// GeoPDF import (GH #3523): a small PDF object reader finds each page's ISO
// 32000 geospatial viewport, and the fitted transform places the map frame.
// The PDFs are built here rather than committed as fixtures.

const encoder = new TextEncoder();

/** WGS 84 / Pseudo-Mercator lat/lon -> metres, the reference the tests check against. */
function mercator(lat: number, lon: number): [number, number] {
  const r = 6378137;
  return [(r * lon * Math.PI) / 180, r * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))];
}

/** Inverse of {@link mercator}. */
function mercatorLatLon(x: number, y: number): [number, number] {
  const r = 6378137;
  return [
    (2 * Math.atan(Math.exp(y / r)) - Math.PI / 2) * (180 / Math.PI),
    (x / r) * (180 / Math.PI),
  ];
}

/** The map frame of the generated pages: a 400 x 300 pt box at (100, 150). */
const BBOX = [100, 150, 500, 450];
/** Mercator corners of the frame: 20 m per PDF point, upper-left at (-9.36e6, 4.29e6). */
const UL = [-9360000, 4290000];
const M_PER_PT = 20;

/** GPTS for the frame's corners, in LPTS order (UL, LL, LR, UR). */
function frameGpts(): number[] {
  const w = (BBOX[2] - BBOX[0]) * M_PER_PT;
  const h = (BBOX[3] - BBOX[1]) * M_PER_PT;
  const corners = [
    [UL[0], UL[1]],
    [UL[0], UL[1] - h],
    [UL[0] + w, UL[1] - h],
    [UL[0] + w, UL[1]],
  ];
  return corners.flatMap(([x, y]) => mercatorLatLon(x, y));
}

/** The `/VP` entry of a page georeferenced like {@link frameGpts}. */
function viewportEntry(
  gcs = "<< /Type /PROJCS /EPSG 3857 >>",
  { bbox = BBOX, lpts = "/LPTS [0 1 0 0 1 0 1 1] ", bounds = "/Bounds [0 1 0 0 1 0 1 1] " } = {},
): string {
  return (
    `/VP [<< /Type /Viewport /Name (Map) /BBox [${bbox.join(" ")}] /Measure << /Type /Measure ` +
    `/Subtype /GEO ${bounds}${lpts}` +
    `/GPTS [${frameGpts().join(" ")}] /GCS ${gcs} >> >>]`
  );
}

/** A one-page PDF with a classic cross-reference table. */
function classicPdf(pageExtra: string): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 600 600] >>",
    `<< /Type /Page /Parent 2 0 R ${pageExtra} >>`,
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder.encode(body);
}

/** PNG "Up" filter rows (predictor 12), as an xref stream writes them. */
function pngUp(rows: number[][]): Uint8Array {
  const out: number[] = [];
  rows.forEach((row, r) => {
    out.push(2);
    row.forEach((byte, c) => out.push((byte - (r > 0 ? rows[r - 1][c] : 0)) & 0xff));
  });
  return new Uint8Array(out);
}

/**
 * A PDF 1.5 file: the catalog, page tree and page sit in a compressed object
 * stream, indexed by a predicted cross-reference stream.
 */
function objectStreamPdf(pageExtra: string): Uint8Array {
  const inner = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 600 600] >>",
    `<< /Type /Page /Parent 2 0 R ${pageExtra} >>`,
  ];
  let header = "";
  let data = "";
  inner.forEach((obj, i) => {
    header += `${i + 1} ${data.length} `;
    data += `${obj}\n`;
  });
  const first = header.length;
  const objStm = zlibSync(encoder.encode(header + data));
  const parts: (string | Uint8Array)[] = [];
  let length = 0;
  const push = (part: string | Uint8Array) => {
    parts.push(part);
    length += typeof part === "string" ? encoder.encode(part).length : part.length;
  };
  push("%PDF-1.5\n");
  const objStmOffset = length;
  push(
    `4 0 obj\n<< /Type /ObjStm /N 3 /First ${first} /Filter /FlateDecode /Length ${objStm.length} >>\nstream\n`,
  );
  push(objStm);
  push("\nendstream\nendobj\n");
  const xrefOffset = length;
  // Rows of [type, field2 (2 bytes), field3]: 0 free, 1-3 in the object stream, 4 and 5 plain.
  const rows = [
    [0, 0, 0, 255],
    [2, 0, 4, 0],
    [2, 0, 4, 1],
    [2, 0, 4, 2],
    [1, (objStmOffset >> 8) & 0xff, objStmOffset & 0xff, 0],
    [1, (xrefOffset >> 8) & 0xff, xrefOffset & 0xff, 0],
  ];
  const xrefData = zlibSync(pngUp(rows));
  push(
    `5 0 obj\n<< /Type /XRef /Size 6 /W [1 2 1] /Root 1 0 R /Filter /FlateDecode ` +
      `/DecodeParms << /Predictor 12 /Columns 4 >> /Length ${xrefData.length} >>\nstream\n`,
  );
  push(xrefData);
  push(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    const bytes = typeof part === "string" ? encoder.encode(part) : part;
    out.set(bytes, at);
    at += bytes.length;
  }
  return out;
}

/** Check a parsed viewport places the frame where {@link frameGpts} says. */
function assertFrame(bytes: Uint8Array) {
  const pages = readGeoPdfPages(bytes);
  assert.equal(pages.length, 1);
  const vp = primaryViewport(pages[0]);
  assert.ok(vp, "the page is georeferenced");
  assert.deepEqual(vp.bbox, BBOX);
  assert.equal(vp.crs.epsg, 3857);
  const t = fitViewportTransform(vp, mercator);
  assert.ok(t);
  const ul = applyUserToCrs(t, BBOX[0], BBOX[3]);
  const lr = applyUserToCrs(t, BBOX[2], BBOX[1]);
  assert.ok(Math.abs(ul[0] - UL[0]) < 1e-3 && Math.abs(ul[1] - UL[1]) < 1e-3);
  assert.ok(Math.abs(lr[0] - (UL[0] + 8000)) < 1e-3 && Math.abs(lr[1] - (UL[1] - 6000)) < 1e-3);
}

describe("readGeoPdfPages", () => {
  it("reads the viewport of a classic PDF", () => {
    assertFrame(classicPdf(viewportEntry()));
  });

  it("reads a viewport inside a compressed object stream", () => {
    assertFrame(objectStreamPdf(viewportEntry()));
  });

  it("recovers from a broken cross-reference by scanning objects", () => {
    const bytes = classicPdf(viewportEntry());
    const text = new TextDecoder().decode(bytes).replace(/startxref\n\d+/, "startxref\n999999");
    assertFrame(encoder.encode(text));
  });

  it("reports a page without a georeference", () => {
    const pages = readGeoPdfPages(classicPdf("/MediaBox [0 0 10 10]"));
    assert.equal(primaryViewport(pages[0]), null);
  });

  it("ignores a viewport whose measure is not geospatial", () => {
    const bytes = classicPdf(
      "/VP [<< /Type /Viewport /BBox [0 0 1 1] /Measure << /Type /Measure /Subtype /RL >> >>]",
    );
    assert.equal(primaryViewport(readGeoPdfPages(bytes)[0]), null);
  });

  it("takes the EPSG code from the WKT when /EPSG is missing", () => {
    const wkt = 'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84"],AUTHORITY["EPSG","3857"]]';
    const bytes = classicPdf(viewportEntry(`<< /Type /PROJCS /WKT (${wkt}) >>`));
    const vp = primaryViewport(readGeoPdfPages(bytes)[0]);
    assert.equal(vp?.crs.epsg, 3857);
    assert.equal(vp?.crs.wkt, wkt);
  });

  it("rejects a file that is not a PDF", () => {
    assert.throws(() => readGeoPdfPages(encoder.encode("hello")), PdfReadError);
  });

  it("refuses an encrypted PDF", () => {
    const text = new TextDecoder()
      .decode(classicPdf(viewportEntry()))
      .replace("/Root 1 0 R", "/Root 1 0 R /Encrypt << /Filter /Standard >>");
    assert.throws(() => new PdfDocument(encoder.encode(text)), /Encrypted/);
  });
});

describe("wktEpsg", () => {
  it("reads only the outermost authority", () => {
    assert.equal(
      wktEpsg('PROJCS["x",GEOGCS["y",AUTHORITY["EPSG","4326"]],AUTHORITY["EPSG","32617"]]'),
      32617,
    );
    assert.equal(wktEpsg('PROJCS["x",GEOGCS["y",AUTHORITY["EPSG","4326"]],UNIT["metre",1]]'), null);
    assert.equal(wktEpsg('PROJCRS["x",ID["EPSG",2100]]'), 2100);
  });
});

describe("fitViewportTransform", () => {
  it("returns null for collinear points", () => {
    const vp = primaryViewport(readGeoPdfPages(classicPdf(viewportEntry()))[0])!;
    const flat = { ...vp, lpts: [0, 0, 0.5, 0.5, 1, 1], gpts: [10, 10, 11, 11, 12, 12] };
    assert.equal(
      fitViewportTransform(flat, (lat, lon) => [lon, lat]),
      null,
    );
  });
});

describe("geoPdfCrsConverters", () => {
  const OSGB =
    "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy " +
    "+towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs";

  it("reads GPTS on the CRS's own datum", async () => {
    const converters = await geoPdfCrsConverters(
      { geographic: false, epsg: 27700, wkt: null },
      async () => OSGB,
      proj4,
    );
    assert.ok(converters);
    assert.equal(converters.label, "EPSG:27700");
    // OSGB36 lat/lon of a grid point, from proj4 without any datum shift.
    const local = proj4(
      `+proj=longlat +ellps=airy +no_defs`,
      `+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +units=m +no_defs`,
    );
    const [lon, lat] = local.inverse([530000, 180000]);
    const [x, y] = converters.latLonToCrs(lat, lon);
    assert.ok(Math.abs(x - 530000) < 1e-3 && Math.abs(y - 180000) < 1e-3);
    // WGS 84 differs from OSGB36 by about 100 m here.
    const [wgsLng] = converters.crsToWgs84(530000, 180000);
    assert.ok(Math.abs(wgsLng - lon) > 5e-4);
  });

  it("falls back to the WKT when the EPSG code is unknown", async () => {
    const wkt =
      'PROJCS["WGS 84 / UTM zone 17N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],' +
      'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],' +
      'PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-81],PARAMETER["scale_factor",0.9996],' +
      'PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1]]';
    const converters = await geoPdfCrsConverters(
      { geographic: false, epsg: 99999, wkt },
      async () => null,
      proj4,
    );
    assert.ok(converters);
    const [x, y] = converters.latLonToCrs(35.9, -84);
    const [lng, lat] = converters.crsToWgs84(x, y);
    assert.ok(Math.abs(lng + 84) < 1e-9 && Math.abs(lat - 35.9) < 1e-9);
    assert.ok(Math.abs(x - 229_000) < 2000, `UTM 17N easting ${x}`);
  });

  it("is null when nothing describes the CRS", async () => {
    assert.equal(
      await geoPdfCrsConverters({ geographic: false, epsg: 1, wkt: null }, async () => null, proj4),
      null,
    );
  });
});

describe("isPdfFileName", () => {
  it("matches .pdf in any case", () => {
    assert.ok(isPdfFileName("map.PDF"));
    assert.ok(!isPdfFileName("map.pdf.zip"));
  });
});

describe("PdfDocument hardening", () => {
  it("falls back to scanning when a classic xref table is truncated", () => {
    // Cut the table after its entries: no trailer, the file just ends.
    const text = new TextDecoder().decode(classicPdf(viewportEntry()));
    const truncated = text.slice(0, text.indexOf("trailer"));
    const withMarker = `${truncated}startxref\n${text.indexOf("xref\n0 ")}\n%%EOF\n`;
    assertFrame(encoder.encode(withMarker));
  });

  it("recovers when the trailer parses but its offsets are stale", () => {
    const text = new TextDecoder().decode(classicPdf(viewportEntry()));
    // Shift every object by padding after the header; the xref table is left as is.
    const shifted = text.replace("%PDF-1.4\n", "%PDF-1.4\n%padding padding padding\n");
    const xref = shifted.indexOf("xref\n0 ");
    assertFrame(encoder.encode(shifted.replace(/startxref\n\d+/, `startxref\n${xref}`)));
  });

  it("treats a free entry from a newer revision as deleted", () => {
    const text = new TextDecoder().decode(classicPdf(viewportEntry()));
    const prev = Number(/startxref\n(\d+)/.exec(text)![1]);
    // An incremental update that frees object 3 (the page).
    const body = text.slice(0, text.lastIndexOf("startxref"));
    const xref = body.length;
    const update =
      `xref\n3 1\n0000000000 00001 f \ntrailer\n<< /Size 4 /Root 1 0 R /Prev ${prev} >>\n` +
      `startxref\n${xref}\n%%EOF\n`;
    const doc = new PdfDocument(encoder.encode(body + update));
    assert.equal(doc.pages().length, 0);
  });

  it("keeps the Encrypt marker when recovering a lost /Root", () => {
    const text = new TextDecoder()
      .decode(classicPdf(viewportEntry()))
      .replace("/Root 1 0 R", "/Encrypt << /Filter /Standard >>");
    assert.throws(() => new PdfDocument(encoder.encode(text)), /Encrypted/);
  });

  it("stops inflating once the output passes the limit", () => {
    const bomb = zlibSync(new Uint8Array(1_000_000));
    assert.throws(() => boundedInflate(bomb, 10_000, false), /too large/);
    assert.equal(boundedInflate(bomb, 2_000_000, false).length, 1_000_000);
  });
});

describe("viewport reading", () => {
  it("skips a viewport without /LPTS", () => {
    const bytes = classicPdf(viewportEntry(undefined, { lpts: "" }));
    assert.equal(primaryViewport(readGeoPdfPages(bytes)[0]), null);
  });

  it("carries the neatline polygon from /Bounds", () => {
    const bytes = classicPdf(viewportEntry(undefined, { bounds: "/Bounds [0 0 0 1 1 0] " }));
    assert.deepEqual(primaryViewport(readGeoPdfPages(bytes)[0])?.bounds, [0, 0, 0, 1, 1, 0]);
  });

  it("fits a small frame far from the page origin", () => {
    const far = [20000, 20000, 20100, 20100];
    const vp = primaryViewport(
      readGeoPdfPages(classicPdf(viewportEntry(undefined, { bbox: far })))[0],
    )!;
    const t = fitViewportTransform(vp, mercator);
    assert.ok(t, "a translated frame is not singular");
    const ul = applyUserToCrs(t, far[0], far[3]);
    assert.ok(Math.abs(ul[0] - UL[0]) < 1e-3 && Math.abs(ul[1] - UL[1]) < 1e-3);
  });

  it("orders viewports largest first", () => {
    const vp = primaryViewport(readGeoPdfPages(classicPdf(viewportEntry()))[0])!;
    const inset = { ...vp, bbox: [0, 0, 10, 10] as [number, number, number, number] };
    assert.deepEqual(viewportsByArea({ index: 0, viewports: [inset, vp] })[0], vp);
  });

  it("ignores authorities nested below the root in a WKT", () => {
    const wkt = 'PROJCS["x",GEOGCS["y"],UNIT["metre",1,AUTHORITY["EPSG","9001"]]]';
    assert.equal(wktEpsg(wkt), null);
    assert.equal(wktEpsg('PROJCS["a [b]",AUTHORITY["EPSG","2100"]]'), 2100);
  });
});

describe("geoPdfCrsConverters prime meridian", () => {
  it("counts GPTS longitudes from the CRS's prime meridian", async () => {
    // NTF (Paris) / Lambert zone II: longitude 0 is the Paris meridian.
    const def =
      "+proj=lcc +lat_1=46.8 +lat_0=46.8 +lon_0=0 +k_0=0.99987742 +x_0=600000 +y_0=2200000 " +
      "+a=6378249.2 +b=6356515 +towgs84=-168,-60,320,0,0,0,0 +pm=paris +units=m +no_defs";
    const c = await geoPdfCrsConverters(
      { geographic: false, epsg: 27572, wkt: null },
      async () => def,
      proj4,
    );
    const [x, y] = c!.latLonToCrs(46.8, 0);
    assert.ok(Math.abs(x - 600000) < 1e-2 && Math.abs(y - 2200000) < 1e-2);
  });
});

describe("Mercator warp", () => {
  /** A geographic (plate carree) frame from 0 to 60 degrees north. */
  const W = 200;
  const H = 300;
  const plate = (px: number, py: number): [number, number] => [
    10 + (px / W) * 40,
    60 - (py / H) * 60,
  ];

  it("leaves a Web Mercator frame to corner placement", () => {
    const [x0, y0] = lngLatToMercator(-84, 36);
    const merc = (px: number, py: number) => mercatorToLngLat(x0 + px * 30, y0 - py * 30);
    assert.ok(isAffineInMercator(W, H, merc));
  });

  it("warps a tall latitude/longitude frame so its interior lands in place", () => {
    assert.ok(!isAffineInMercator(W, H, plate));
    const plan = planMercatorWarp(W, H, plate, 1000);
    const corners = warpCorners(plan);
    assert.ok(Math.abs(corners[0][0] - 10) < 1e-6 && Math.abs(corners[0][1] - 60) < 1e-6);
    assert.ok(Math.abs(corners[2][0] - 50) < 1e-6 && Math.abs(corners[2][1]) < 1e-6);
    // A source whose red channel is its row: the output row at 30 N must hold
    // source row 150, halfway down the plate carree frame.
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        data[(y * W + x) * 4] = Math.round((y / H) * 255);
        data[(y * W + x) * 4 + 3] = 255;
      }
    const out = warpToMercator({ width: W, height: H, data }, plan, (lng, lat) => [
      ((lng - 10) / 40) * W,
      ((60 - lat) / 60) * H,
    ]);
    const [, yTop] = lngLatToMercator(0, 60);
    const [, y30] = lngLatToMercator(0, 30);
    const [, yBottom] = lngLatToMercator(0, 0);
    const row = Math.floor(((yTop - y30) / (yTop - yBottom)) * out.height);
    const red = out.data[(row * out.width + Math.floor(out.width / 2)) * 4];
    assert.ok(Math.abs(red - 128) <= 3, `row at 30 N holds source row ~150 (red ${red})`);
  });
});

describe("handOffDroppedPdfs", () => {
  it("opens the first readable PDF and names the others", async () => {
    let opened = 0;
    let notified = 0;
    const stop = subscribePendingGeoPdf(() => notified++);
    const name = await handOffDroppedPdfs(
      ["bad.pdf", "a.pdf", "b.pdf"],
      (file) => file,
      async (file) => {
        if (file === "bad.pdf") throw new Error("unreadable");
        return encoder.encode(file);
      },
      () => opened++,
    );
    stop();
    assert.equal(name, "a.pdf");
    assert.equal(opened, 1);
    assert.equal(notified, 1);
    const pending = takePendingGeoPdf();
    assert.equal(pending?.name, "a.pdf");
    assert.deepEqual(pending?.skipped, ["bad.pdf", "b.pdf"]);
    assert.equal(takePendingGeoPdf(), null);
  });

  it("rejects when no PDF can be read", async () => {
    await assert.rejects(
      handOffDroppedPdfs(
        ["x.pdf"],
        (f) => f,
        async () => {
          throw new Error("nope");
        },
        () => {},
      ),
      /nope/,
    );
  });
});
