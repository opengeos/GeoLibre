import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import proj4 from "proj4";
import {
  renderStacTile,
  type RenderBand,
  type StacRenderSpec,
} from "../packages/plugins/src/plugins/stac-render";

/**
 * A 32 x 32 single-band, uncompressed, tiled GeoTIFF (four 16 x 16 tiles) over Belgium
 * (4..5.6 E, 50.4..52 N, EPSG:4326). The renderer reads tiled files, and the usual writers produce
 * stripes, so the few tags it needs are laid out by hand. Pixel values vary, so a render that
 * read nothing or the wrong window would show.
 */
function tinyCog(projected = false): Buffer {
  const SHORT = 3;
  const LONG = 4;
  const DOUBLE = 12;
  const tile = 16 * 16;
  // Either lon/lat, or WGS 84 / UTM zone 31N with 3.5 km pixels covering the same ground.
  const geoKeys = projected
    ? [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 32631]
    : [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326];
  const utm = proj4("EPSG:4326", "+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs");
  const [originX, originY] = utm.forward([4, 52]);
  const pixel = projected ? [3500, 3500, 0] : [0.05, 0.05, 0];
  const tiepoint = projected ? [0, 0, 0, originX, originY, 0] : [0, 0, 0, 4, 52, 0];
  const entryCount = 14;
  let cursor = 8 + 2 + 12 * entryCount + 4;
  const place = (bytes: number): number => {
    const at = cursor;
    cursor += bytes;
    return at;
  };
  const at = {
    tileOffsets: place(16),
    tileCounts: place(16),
    scale: place(24),
    tiepoint: place(48),
    geoKeys: place(geoKeys.length * 2),
  };
  const dataStart = cursor;
  const entries: Array<[number, number, number, number]> = [
    [256, SHORT, 1, 32],
    [257, SHORT, 1, 32],
    [258, SHORT, 1, 8],
    [259, SHORT, 1, 1],
    [262, SHORT, 1, 1],
    [277, SHORT, 1, 1],
    [284, SHORT, 1, 1],
    [322, SHORT, 1, 16],
    [323, SHORT, 1, 16],
    [324, LONG, 4, at.tileOffsets],
    [325, LONG, 4, at.tileCounts],
    [33550, DOUBLE, 3, at.scale],
    [33922, DOUBLE, 6, at.tiepoint],
    [34735, SHORT, geoKeys.length, at.geoKeys],
  ];
  assert.equal(entries.length, entryCount);
  const out = new DataView(new ArrayBuffer(dataStart + 4 * tile));
  out.setUint16(0, 0x4949, true);
  out.setUint16(2, 42, true);
  out.setUint32(4, 8, true);
  out.setUint16(8, entries.length, true);
  entries.forEach(([tag, type, count, value], i) => {
    const base = 10 + i * 12;
    out.setUint16(base, tag, true);
    out.setUint16(base + 2, type, true);
    out.setUint32(base + 4, count, true);
    if (type === SHORT && count === 1) out.setUint16(base + 8, value, true);
    else out.setUint32(base + 8, value, true);
  });
  [0, 1, 2, 3].forEach((i) => {
    out.setUint32(at.tileOffsets + i * 4, dataStart + i * tile, true);
    out.setUint32(at.tileCounts + i * 4, tile, true);
  });
  pixel.forEach((v, i) => out.setFloat64(at.scale + i * 8, v, true));
  tiepoint.forEach((v, i) => out.setFloat64(at.tiepoint + i * 8, v, true));
  geoKeys.forEach((v, i) => out.setUint16(at.geoKeys + i * 2, v, true));
  for (let i = 0; i < 4 * tile; i++) out.setUint8(dataStart + i, (i * 7) % 251);
  return Buffer.from(out.buffer);
}

let server: Server;
let href = "";
let utmHref = "";

/** Serves a file with range reads, the way object storage does. */
function serve(body: Buffer): Server {
  return createServer((request, response) => {
    const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? "");
    if (!range) {
      response.writeHead(200, { "accept-ranges": "bytes", "content-length": body.length });
      response.end(body);
      return;
    }
    const start = Number(range[1]);
    const end = Math.min(body.length - 1, range[2] ? Number(range[2]) : body.length - 1);
    response.writeHead(206, {
      "accept-ranges": "bytes",
      "content-range": `bytes ${start}-${end}/${body.length}`,
      "content-length": end - start + 1,
    });
    response.end(body.subarray(start, end + 1));
  });
}

let utmServer: Server;

before(async () => {
  server = serve(tinyCog());
  utmServer = serve(tinyCog(true));
  await Promise.all(
    [server, utmServer].map(
      (s) => new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve)),
    ),
  );
  href = `http://127.0.0.1:${(server.address() as AddressInfo).port}/image.tif`;
  utmHref = `http://127.0.0.1:${(utmServer.address() as AddressInfo).port}/image.tif`;
});

after(() => {
  server.close();
  utmServer.close();
});

/** The slippy-map tile holding a point at a zoom. */
function tileAt(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return { x, y };
}

const band = (): RenderBand => ({ href, index: 1, scale: 1, offset: 0 });

test("a colour composite reads the file's pixels, warps them and paints opaque colour", async () => {
  const z = 9;
  const { x, y } = tileAt(4.8, 51.2, z);
  const spec: StacRenderSpec = { kind: "rgb", bands: [band(), band(), band()] };
  const rgba = await renderStacTile({ z, x, y, spec });
  assert.ok(rgba, "a tile inside the file's footprint is drawn");
  assert.equal(rgba.length, 256 * 256 * 4);
  const reds = new Set<number>();
  for (let i = 0; i < rgba.length; i += 4) {
    assert.equal(rgba[i + 3], 255, "every pixel inside the footprint is opaque");
    // The same band in all three channels is grey.
    assert.equal(rgba[i], rgba[i + 1]);
    assert.equal(rgba[i], rgba[i + 2]);
    reds.add(rgba[i]);
  }
  assert.ok(reds.size > 5, "the image's values come through, not a flat fill");
});

test("an index evaluates its formula on the file's values", async () => {
  const z = 9;
  const { x, y } = tileAt(4.8, 51.2, z);
  // The same band twice, so a - b is 0 everywhere: the pale middle of the ramp.
  const spec: StacRenderSpec = { kind: "index", formula: "a - b", bands: [band(), band()] };
  const rgba = await renderStacTile({ z, x, y, spec });
  assert.ok(rgba);
  for (let i = 0; i < rgba.length; i += 4) {
    assert.deepEqual([...rgba.slice(i, i + 4)], [0xf5, 0xf5, 0xf5, 255]);
  }
});

test("a tile outside the file's footprint is not drawn", async () => {
  const z = 9;
  // Well south of the image (Spain), so the window misses it.
  const { x, y } = tileAt(-3.7, 40.4, z);
  const spec: StacRenderSpec = { kind: "rgb", bands: [band(), band(), band()] };
  assert.equal(await renderStacTile({ z, x, y, spec }), null);
});

test("a brightness gain brightens the same pixels", async () => {
  const z = 9;
  const { x, y } = tileAt(4.8, 51.2, z);
  const plain: StacRenderSpec = { kind: "rgb", bands: [band(), band(), band()] };
  const bright: StacRenderSpec = { ...plain, style: { gain: 1.5 } };
  const [a, b] = await Promise.all([
    renderStacTile({ z, x, y, spec: plain }),
    renderStacTile({ z, x, y, spec: bright }),
  ]);
  assert.ok(a && b);
  const mean = (data: Uint8ClampedArray): number => {
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += data[i];
    return sum / (data.length / 4);
  };
  assert.ok(mean(b) > mean(a), "a gain above 1 raises the average");
});

test("a file in a projected CRS is warped from its own projection", async () => {
  const z = 9;
  // Inside the UTM image: 4..5.6 E, and 52 N down about 112 km.
  const { x, y } = tileAt(4.8, 51.5, z);
  const utmBand = (): RenderBand => ({ href: utmHref, index: 1, scale: 1, offset: 0 });
  const spec: StacRenderSpec = { kind: "rgb", bands: [utmBand(), utmBand(), utmBand()] };
  const rgba = await renderStacTile({ z, x, y, spec });
  assert.ok(rgba, "a tile over the file is drawn");
  const reds = new Set<number>();
  for (let i = 0; i < rgba.length; i += 4) {
    assert.equal(rgba[i + 3], 255, "the whole tile is inside the footprint");
    reds.add(rgba[i]);
  }
  assert.ok(reds.size > 5, "values come through the projection, not a flat fill");
  // The same ground in the other file: the two grids differ, but both cover this tile.
  const lonLat = await renderStacTile({
    z,
    x,
    y,
    spec: { kind: "rgb", bands: [band(), band(), band()] },
  });
  assert.ok(lonLat);
  // A tile far outside the UTM image is not drawn.
  const far = tileAt(-3.7, 40.4, z);
  assert.equal(await renderStacTile({ z, x: far.x, y: far.y, spec }), null);
});
