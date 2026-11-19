import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { jsPDF } from "jspdf";
import {
  epsgFromCode,
  geographicDefinitionOf,
  geoPdfViewportEntry,
  georefLngLat,
  solveCaptureGeoref,
  WEB_MERCATOR,
} from "../apps/geolibre-desktop/src/lib/geopdf";
import {
  exportDpiForPage,
  MAX_EXPORT_CANVAS_PIXELS,
  mapImagePlacement,
  pagePx,
  type LayoutOptions,
} from "../apps/geolibre-desktop/src/lib/print-layout";
import { writeGeoPdfViewports } from "../apps/geolibre-desktop/src/lib/print-layout-export";

// GeoPDF export (GH #3523): a captured map image is georeferenced by an affine
// transform from its pixels to the map's CRS, checked across the image, and
// written into the PDF page as an ISO 32000 geospatial viewport.

const WIDTH = 800;
const HEIGHT = 600;

/**
 * A Web Mercator view: image pixel -> lng/lat, optionally rotated by a bearing
 * and pitched (a perspective divide that no affine transform reproduces).
 */
function mercatorView(opts: { bearingDeg?: number; pitch?: number } = {}) {
  const [cx, cy] = WEB_MERCATOR.forward(10, 50);
  const metersPerPx = 20;
  const theta = ((opts.bearingDeg ?? 0) * Math.PI) / 180;
  const pitch = opts.pitch ?? 0;
  return (px: number, py: number) => {
    const sx = px - WIDTH / 2;
    const sy = py - HEIGHT / 2;
    // Rows further up the screen are further away on a pitched map.
    const depth = 1 + pitch * (sy / HEIGHT);
    const ex = (sx / depth) * metersPerPx;
    const ey = (-sy / depth) * metersPerPx;
    const x = cx + ex * Math.cos(theta) + ey * Math.sin(theta);
    const y = cy - ex * Math.sin(theta) + ey * Math.cos(theta);
    const [lng, lat] = WEB_MERCATOR.inverse(x, y);
    return { lng, lat };
  };
}

describe("solveCaptureGeoref", () => {
  it("georeferences a north-up Web Mercator capture", () => {
    const locate = mercatorView();
    const georef = solveCaptureGeoref(WIDTH, HEIGHT, locate, WEB_MERCATOR);
    assert.ok(georef);
    const [b, c, e, f] = [
      georef.transform[1],
      georef.transform[2],
      georef.transform[4],
      georef.transform[5],
    ];
    assert.ok(Math.abs(b - 20) < 1e-6);
    assert.ok(Math.abs(f + 20) < 1e-6);
    assert.ok(Math.abs(c) < 1e-6 && Math.abs(e) < 1e-6);
    const [lng, lat] = georefLngLat(georef, 123, 456);
    const expected = locate(123, 456);
    assert.ok(Math.abs(lng - expected.lng) < 1e-9);
    assert.ok(Math.abs(lat - expected.lat) < 1e-9);
  });

  it("georeferences a rotated (bearing) capture", () => {
    const locate = mercatorView({ bearingDeg: 30 });
    const georef = solveCaptureGeoref(WIDTH, HEIGHT, locate, WEB_MERCATOR);
    assert.ok(georef);
    const [lng, lat] = georefLngLat(georef, 700, 80);
    assert.ok(Math.abs(lng - locate(700, 80).lng) < 1e-9);
    assert.ok(Math.abs(lat - locate(700, 80).lat) < 1e-9);
  });

  it("refuses a pitched capture, which no affine transform fits", () => {
    assert.equal(
      solveCaptureGeoref(WIDTH, HEIGHT, mercatorView({ pitch: 0.5 }), WEB_MERCATOR),
      null,
    );
  });

  it("refuses a capture across the antimeridian", () => {
    // Centred on 179.9 E at 200 m/px: the right edge unwraps to about 180.6.
    const [cx, cy] = WEB_MERCATOR.forward(179.9, 50);
    const locate = (px: number, py: number) => {
      const [lng, lat] = WEB_MERCATOR.inverse(
        cx + (px - WIDTH / 2) * 200,
        cy - (py - HEIGHT / 2) * 200,
      );
      return { lng, lat };
    };
    assert.equal(solveCaptureGeoref(WIDTH, HEIGHT, locate, WEB_MERCATOR), null);
  });

  it("refuses a capture with an off-map corner", () => {
    const locate = mercatorView();
    const offMap = (px: number, py: number) => (px === 0 && py === 0 ? null : locate(px, py));
    assert.equal(solveCaptureGeoref(WIDTH, HEIGHT, offMap, WEB_MERCATOR), null);
  });
});

describe("epsgFromCode", () => {
  it("reads EPSG codes and rejects other authorities", () => {
    assert.equal(epsgFromCode("EPSG:3031"), 3031);
    assert.equal(epsgFromCode("epsg:32633"), 32633);
    assert.equal(epsgFromCode("IAU_2015:30100"), null);
  });
});

/** Layout options with only what the page geometry reads. */
function layoutWith(mapFit: "cover" | "contain"): LayoutOptions {
  return {
    title: "",
    subtitle: "",
    paperSize: "a4",
    orientation: "landscape",
    showTitle: false,
    showLegend: false,
    showScaleBar: false,
    showNorthArrow: false,
    showFooter: false,
    footerText: "",
    showDate: false,
    showAttribution: false,
    pageMargin: "none",
    legend: [],
    metersPerPixel: 20,
    bearingDeg: 0,
    mapImage: {} as CanvasImageSource,
    mapImageWidth: WIDTH,
    mapImageHeight: HEIGHT,
    mapFit,
  } as unknown as LayoutOptions;
}

describe("mapImagePlacement", () => {
  it("clips a cover-fitted image to the map body", () => {
    const placement = mapImagePlacement(layoutWith("cover"), 2970, 2100);
    assert.ok(placement);
    // No margins: the body is the whole page, and cover fills it.
    assert.deepEqual(placement.clip, { x: 0, y: 0, w: 2970, h: 2100 });
    assert.ok(placement.dy < 0, "the taller-than-page image overflows vertically");
  });

  it("keeps only the drawn image of a contain-fitted map", () => {
    const placement = mapImagePlacement(layoutWith("contain"), 2970, 2100);
    assert.ok(placement);
    assert.equal(placement.clip.h, 2100);
    assert.ok(Math.abs(placement.clip.w - 2800) < 1e-9);
    assert.ok(Math.abs(placement.clip.x - 85) < 1e-9);
  });

  it("is null without a captured image", () => {
    assert.equal(mapImagePlacement({ ...layoutWith("cover"), mapImage: null }, 100, 100), null);
  });
});

describe("geoPdfViewportEntry", () => {
  const georef = solveCaptureGeoref(WIDTH, HEIGHT, mercatorView(), WEB_MERCATOR)!;
  const placement = { clip: { x: 100, y: 50, w: 800, h: 600 }, dx: 100, dy: 50, scale: 1 };

  it("writes the frame corners as lat/lon in LPTS order", () => {
    const entry = geoPdfViewportEntry(georef, placement, 1000, 700, 500, 350);
    assert.ok(entry);
    assert.match(entry, /^\/VP \[<< \/Type \/Viewport/);
    assert.match(entry, /\/BBox \[50 25 450 325\]/);
    assert.match(entry, /\/LPTS \[0 1 0 0 1 0 1 1\]/);
    assert.match(
      entry,
      /\/GCS << \/Type \/PROJCS \/EPSG 3857 \/WKT \(PROJCS\["WGS 84 \/ Pseudo-Mercator"/,
    );
    const gpts = /\/GPTS \[([^\]]+)\]/.exec(entry)![1].split(" ").map(Number);
    const locate = mercatorView();
    const corners = [locate(0, 0), locate(0, HEIGHT), locate(WIDTH, HEIGHT), locate(WIDTH, 0)];
    corners.forEach((corner, i) => {
      assert.ok(Math.abs(gpts[i * 2] - corner.lat) < 1e-8, `lat ${i}`);
      assert.ok(Math.abs(gpts[i * 2 + 1] - corner.lng) < 1e-8, `lng ${i}`);
    });
  });

  it("is null when a frame corner is past the antimeridian", () => {
    const shifted = {
      ...georef,
      transform: [WEB_MERCATOR.forward(179.99, 50)[0], 20, 0, georef.transform[3], 0, -20] as const,
    };
    assert.equal(geoPdfViewportEntry(shifted, placement, 1000, 700, 500, 350), null);
  });

  it("is null for a CRS with neither an EPSG code nor a WKT", () => {
    const bare = { ...georef, projection: { ...WEB_MERCATOR, epsg: null, wkt: null } };
    assert.equal(geoPdfViewportEntry(bare, placement, 1000, 700, 500, 350), null);
  });
});

describe("writeGeoPdfViewports", () => {
  it("writes each page's viewport into its page dictionary", () => {
    const pdf = new jsPDF({ unit: "pt", format: [500, 350], orientation: "landscape" });
    pdf.addPage([500, 350], "landscape");
    writeGeoPdfViewports(pdf, [null, "/VP [<< /Type /Viewport >>]"]);
    const text = pdf.output();
    const pages = text.split("/Type /Page\n").slice(1);
    assert.equal(pages.length, 2);
    assert.ok(!pages[0].split("endobj")[0].includes("/VP"));
    assert.ok(pages[1].split("endobj")[0].includes("/VP [<< /Type /Viewport >>]"));
  });
});

describe("geographicDefinitionOf", () => {
  it("keeps the datum and drops the projection", () => {
    const osgb =
      "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy " +
      "+towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs";
    assert.equal(
      geographicDefinitionOf(osgb),
      "+proj=longlat +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +no_defs",
    );
  });

  it("writes GPTS on the CRS's own datum", async () => {
    const { default: proj4 } = await import("proj4");
    const def =
      "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy " +
      "+towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs";
    const wgs = proj4(def);
    const local = proj4(def, geographicDefinitionOf(def));
    const projection = {
      epsg: 27700,
      wkt: null,
      geographic: false,
      forward: (lng: number, lat: number) => wgs.forward([lng, lat]) as [number, number],
      inverse: (x: number, y: number) => wgs.inverse([x, y]) as [number, number],
      datumInverse: (x: number, y: number) => local.forward([x, y]) as [number, number],
    };
    // A 1 m/px north-up image whose top-left pixel is at (530000, 180000).
    const georef = { transform: [530000, 1, 0, 180000, 0, -1] as const, projection };
    const placement = { clip: { x: 0, y: 0, w: 100, h: 100 }, dx: 0, dy: 0, scale: 1 };
    const entry = geoPdfViewportEntry(georef, placement, 100, 100, 100, 100)!;
    const [lat, lng] = /\/GPTS \[([^\]]+)\]/.exec(entry)![1].split(" ").map(Number);
    const [airyLng, airyLat] = local.forward([530000, 180000]);
    const [wgsLng] = wgs.inverse([530000, 180000]);
    assert.ok(Math.abs(lng - airyLng) < 1e-9 && Math.abs(lat - airyLat) < 1e-9);
    // OSGB36 and WGS 84 longitudes differ by roughly 100 m here.
    assert.ok(Math.abs(lng - wgsLng) > 5e-4);
  });
});

describe("exportDpiForPage", () => {
  it("keeps a page that fits the canvas limit at the chosen DPI", () => {
    assert.equal(exportDpiForPage({ width: 297, height: 210, unit: "mm" }, 300), 300);
  });

  it("lowers the DPI just enough for A3 and Tabloid at 300", () => {
    for (const size of [
      { width: 297, height: 420, unit: "mm" as const },
      { width: 279.4, height: 431.8, unit: "mm" as const },
    ]) {
      const dpi = exportDpiForPage(size, 300);
      assert.ok(dpi < 300 && dpi > 280, `dpi ${dpi}`);
      const { width, height } = pagePx(size, dpi);
      assert.ok(width * height <= MAX_EXPORT_CANVAS_PIXELS);
    }
  });

  it("accounts for each side being rounded to whole pixels", () => {
    const size = { width: 423.38, height: 284.06, unit: "mm" as const };
    const { width, height } = pagePx(size, exportDpiForPage(size, 300));
    assert.ok(width * height <= MAX_EXPORT_CANVAS_PIXELS);
  });

  it("ignores DPI for a screen-sized page", () => {
    assert.equal(exportDpiForPage({ width: 3840, height: 2160, unit: "px" }, 300), 300);
  });
});
