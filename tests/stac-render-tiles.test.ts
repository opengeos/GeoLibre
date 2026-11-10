import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after } from "node:test";
import proj4 from "proj4";
import {
  renderStacTile,
  type RenderBand,
  type StacRenderSpec,
} from "../packages/plugins/src/plugins/stac-render";

const SHORT = 3;
const LONG = 4;
const DOUBLE = 12;

interface TiffOptions {
  width: number;
  height: number;
  /** Tile edge in pixels; the image is a whole number of tiles each way. */
  tile?: number;
  /** WGS 84 / UTM zone 31N instead of lon/lat. */
  projected?: boolean;
  /** Pixel size in degrees (or metres, when projected). */
  pixelX: number;
  pixelY: number;
  /** The top-left corner as lon/lat; projected files convert it. */
  origin?: [number, number];
  /** The value of the pixel at a column and row. */
  value?: (col: number, row: number) => number;
  /** Add a transparency-mask page of its own, as GDAL does for a COG with an internal mask. */
  mask?: boolean;
}

/**
 * A single-band, uncompressed, *tiled* 8-bit GeoTIFF, built by hand because the usual writers make
 * stripes and the renderer reads tiled files. Optionally with a mask page after the image.
 */
function buildTiff(options: TiffOptions): Buffer {
  const tile = options.tile ?? 16;
  const { width, height } = options;
  const tilesAcross = width / tile;
  const tilesDown = height / tile;
  const tileCount = tilesAcross * tilesDown;
  const tileBytes = tile * tile;
  const value = options.value ?? ((col, row) => (col * 7 + row * 13) % 251);
  const [lon, lat] = options.origin ?? [4, 52];
  const origin = options.projected
    ? proj4("EPSG:4326", "+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs").forward([lon, lat])
    : [lon, lat];
  const geoKeys = options.projected
    ? [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 32631]
    : [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326];

  type Entry = [tag: number, type: number, count: number, valueOrOffset: number];
  const pages = options.mask ? [false, true] : [false];
  // Lay out: header, then for each page its directory and the arrays it points at, then the data.
  let cursor = 8;
  const place = (bytes: number): number => {
    const at = cursor;
    cursor += bytes;
    return at;
  };
  const layout = pages.map((isMask) => {
    const entryCount = isMask ? 12 : 14;
    const directory = place(2 + 12 * entryCount + 4);
    return {
      isMask,
      directory,
      offsets: place(4 * tileCount),
      counts: place(4 * tileCount),
      scale: isMask ? 0 : place(24),
      tiepoint: isMask ? 0 : place(48),
      geoKeys: isMask ? 0 : place(geoKeys.length * 2),
    };
  });
  const dataStart = cursor;
  const dataOf = layout.map((_page, index) => dataStart + index * tileCount * tileBytes);
  const out = new DataView(new ArrayBuffer(dataStart + pages.length * tileCount * tileBytes));
  out.setUint16(0, 0x4949, true);
  out.setUint16(2, 42, true);
  out.setUint32(4, layout[0].directory, true);

  layout.forEach((page, index) => {
    const entries: Entry[] = [];
    if (page.isMask) entries.push([254, LONG, 1, 4]);
    entries.push(
      [256, SHORT, 1, width],
      [257, SHORT, 1, height],
      [258, SHORT, 1, 8],
      [259, SHORT, 1, 1],
      // 4 is "transparency mask"; 1 is "black is zero".
      [262, SHORT, 1, page.isMask ? 4 : 1],
      [277, SHORT, 1, 1],
      [284, SHORT, 1, 1],
      [322, SHORT, 1, tile],
      [323, SHORT, 1, tile],
      [324, LONG, tileCount, page.offsets],
      [325, LONG, tileCount, page.counts],
    );
    if (!page.isMask) {
      entries.push(
        [33550, DOUBLE, 3, page.scale],
        [33922, DOUBLE, 6, page.tiepoint],
        [34735, SHORT, geoKeys.length, page.geoKeys],
      );
    }
    const base = page.directory;
    out.setUint16(base, entries.length, true);
    entries.forEach(([tag, type, count, valueOrOffset], i) => {
      const at = base + 2 + i * 12;
      out.setUint16(at, tag, true);
      out.setUint16(at + 2, type, true);
      out.setUint32(at + 4, count, true);
      if (type === SHORT && count === 1) out.setUint16(at + 8, valueOrOffset, true);
      else out.setUint32(at + 8, valueOrOffset, true);
    });
    // The next directory, or none.
    out.setUint32(base + 2 + 12 * entries.length, layout[index + 1]?.directory ?? 0, true);
    for (let t = 0; t < tileCount; t++) {
      out.setUint32(page.offsets + t * 4, dataOf[index] + t * tileBytes, true);
      out.setUint32(page.counts + t * 4, tileBytes, true);
    }
    if (!page.isMask) {
      [options.pixelX, options.pixelY, 0].forEach((v, i) =>
        out.setFloat64(page.scale + i * 8, v, true),
      );
      [0, 0, 0, origin[0], origin[1], 0].forEach((v, i) =>
        out.setFloat64(page.tiepoint + i * 8, v, true),
      );
      geoKeys.forEach((v, i) => out.setUint16(page.geoKeys + i * 2, v, true));
    }
    for (let t = 0; t < tileCount; t++) {
      const tileCol = t % tilesAcross;
      const tileRow = Math.floor(t / tilesAcross);
      for (let r = 0; r < tile; r++) {
        for (let c = 0; c < tile; c++) {
          const byte = page.isMask ? 255 : value(tileCol * tile + c, tileRow * tile + r);
          out.setUint8(dataOf[index] + t * tileBytes + r * tile + c, byte);
        }
      }
    }
  });
  return Buffer.from(out.buffer);
}

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

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

/** Serves a built file and returns its address. */
async function host(options: TiffOptions): Promise<string> {
  const server = serve(buildTiff(options));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/image.tif`;
}

/** The slippy-map tile holding a point at a zoom. */
function tileAt(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return { x, y };
}

/** The lon/lat at the centre of a pixel of a tile, worked out independently of the renderer. */
function lonLatOfPixel(
  z: number,
  x: number,
  y: number,
  px: number,
  py: number,
): { lon: number; lat: number } {
  const n = 2 ** z;
  const lon = ((x + (px + 0.5) / 256) / n) * 360 - 180;
  const merc = Math.PI * (1 - (2 * (y + (py + 0.5) / 256)) / n);
  const lat = (Math.atan(Math.sinh(merc)) * 180) / Math.PI;
  return { lon, lat };
}

const bandOf = (href: string, extra: Partial<RenderBand> = {}): RenderBand => ({
  href,
  index: 1,
  scale: 1,
  offset: 0,
  ...extra,
});
const rgbOf = (href: string, extra: Partial<RenderBand> = {}): StacRenderSpec => ({
  kind: "rgb",
  bands: [bandOf(href, extra), bandOf(href, extra), bandOf(href, extra)],
});

/** The 32 x 32 file over Belgium (4..5.6 E, 50.4..52 N). */
const BELGIUM: TiffOptions = { width: 32, height: 32, pixelX: 0.05, pixelY: 0.05 };

test("a colour composite reads the file's pixels, warps them and paints opaque colour", async () => {
  const href = await host(BELGIUM);
  const z = 9;
  const { x, y } = tileAt(4.8, 51.2, z);
  const rgba = await renderStacTile({ z, x, y, spec: rgbOf(href) });
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

test("each output pixel shows the file pixel at its own location, not a mirrored or shifted one", async () => {
  const href = await host(BELGIUM);
  const z = 9;
  const { x, y } = tileAt(4.8, 51.2, z);
  const rgba = await renderStacTile({ z, x, y, spec: rgbOf(href) });
  assert.ok(rgba);
  const value = (col: number, row: number) => (col * 7 + row * 13) % 251;
  let checked = 0;
  let matching = 0;
  for (let py = 8; py < 256; py += 16) {
    for (let px = 8; px < 256; px += 16) {
      const { lon, lat } = lonLatOfPixel(z, x, y, px, py);
      const col = Math.floor((lon - 4) / 0.05);
      const row = Math.floor((52 - lat) / 0.05);
      checked += 1;
      if (rgba[(py * 256 + px) * 4] === value(col, row)) matching += 1;
    }
  }
  // Nearest-neighbour on an interpolated grid can land a pixel on its neighbour at a cell edge.
  assert.ok(matching / checked > 0.9, `${matching} of ${checked} sampled pixels match`);
});

test("a file in a projected CRS shows each pixel at its own location too", async () => {
  // UTM zone 31N pixels of 3.5 km, from the same corner.
  const href = await host({ ...BELGIUM, projected: true, pixelX: 3500, pixelY: 3500 });
  const z = 9;
  const { x, y } = tileAt(4.8, 51.5, z);
  const rgba = await renderStacTile({ z, x, y, spec: rgbOf(href) });
  assert.ok(rgba, "a tile over the file is drawn");
  const utm = proj4("EPSG:4326", "+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs");
  const [originX, originY] = utm.forward([4, 52]);
  const value = (col: number, row: number) => (col * 7 + row * 13) % 251;
  let checked = 0;
  let matching = 0;
  for (let py = 8; py < 256; py += 16) {
    for (let px = 8; px < 256; px += 16) {
      const { lon, lat } = lonLatOfPixel(z, x, y, px, py);
      const [easting, northing] = utm.forward([lon, lat]);
      const col = Math.floor((easting - originX) / 3500);
      const row = Math.floor((originY - northing) / 3500);
      assert.ok(col >= 0 && col < 32 && row >= 0 && row < 32, "the tile lies inside the file");
      checked += 1;
      assert.equal(rgba[(py * 256 + px) * 4 + 3], 255);
      if (rgba[(py * 256 + px) * 4] === value(col, row)) matching += 1;
    }
  }
  assert.ok(matching / checked > 0.9, `${matching} of ${checked} sampled pixels match`);
});

test("rows are found with the vertical pixel size when it differs from the horizontal one", async () => {
  // Pixels twice as tall as wide: reading rows with the horizontal size would land on the wrong ones.
  const href = await host({ width: 32, height: 32, pixelX: 0.05, pixelY: 0.1 });
  const z = 9;
  const { x, y } = tileAt(4.8, 51.0, z);
  const rgba = await renderStacTile({ z, x, y, spec: rgbOf(href) });
  assert.ok(rgba);
  const value = (col: number, row: number) => (col * 7 + row * 13) % 251;
  let checked = 0;
  let matching = 0;
  for (let py = 8; py < 256; py += 16) {
    for (let px = 8; px < 256; px += 16) {
      const { lon, lat } = lonLatOfPixel(z, x, y, px, py);
      const col = Math.floor((lon - 4) / 0.05);
      const row = Math.floor((52 - lat) / 0.1);
      if (row < 0 || row >= 32 || col < 0 || col >= 32) continue;
      checked += 1;
      if (rgba[(py * 256 + px) * 4] === value(col, row)) matching += 1;
    }
  }
  assert.ok(checked > 100, "the tile is mostly over the file");
  assert.ok(matching / checked > 0.9, `${matching} of ${checked} sampled pixels match`);
});

test("a mask page in the file is not read as imagery", async () => {
  const plain = await host(BELGIUM);
  const masked = await host({ ...BELGIUM, mask: true });
  // Zoomed out until the tile needs a pixel coarser than the file's own, which is when a mask page
  // of the same size would be taken for the overview that is wanted.
  const z = 4;
  const { x, y } = tileAt(4.8, 51.2, z);
  const [without, withMask] = await Promise.all([
    renderStacTile({ z, x, y, spec: rgbOf(plain) }),
    renderStacTile({ z, x, y, spec: rgbOf(masked) }),
  ]);
  assert.ok(without && withMask);
  let painted = 0;
  for (let i = 3; i < without.length; i += 4) if (without[i] === 255) painted += 1;
  assert.ok(painted > 100, "the file shows in this tile");
  // The mask is all 255, so reading it would paint flat white where the image has its values.
  assert.deepEqual([...withMask], [...without]);
});

test("a band's declared no-data value is transparent, and none is assumed without one", async () => {
  const href = await host(BELGIUM);
  const z = 9;
  const { x, y } = tileAt(4.8, 51.2, z);
  const transparent = (rgba: Uint8ClampedArray): number => {
    let count = 0;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] === 0) count += 1;
    return count;
  };
  const plain = await renderStacTile({ z, x, y, spec: rgbOf(href) });
  assert.ok(plain);
  assert.equal(transparent(plain), 0, "no declaration, nothing is treated as missing");
  // Pixel (0, 0) holds 0; declare 0 as no data and the pixels of the value 0 disappear.
  const declared = await renderStacTile({ z, x, y, spec: rgbOf(href, { nodata: 7 }) });
  assert.ok(declared);
  assert.ok(transparent(declared) > 0, "the declared value is transparent");
  // Opaque pixels are the same as before.
  for (let i = 0; i < declared.length; i += 4) {
    if (declared[i + 3] !== 0) assert.equal(declared[i], plain[i]);
  }
});

test("an index evaluates its formula on the file's values", async () => {
  const href = await host(BELGIUM);
  const z = 9;
  const { x, y } = tileAt(4.8, 51.2, z);
  // The same band twice, so a - b is 0 everywhere: the pale middle of the ramp.
  const spec: StacRenderSpec = {
    kind: "index",
    formula: "a - b",
    bands: [bandOf(href), bandOf(href)],
  };
  const rgba = await renderStacTile({ z, x, y, spec });
  assert.ok(rgba);
  for (let i = 0; i < rgba.length; i += 4) {
    assert.deepEqual([...rgba.slice(i, i + 4)], [0xf5, 0xf5, 0xf5, 255]);
  }
});

test("a tile outside the file's footprint is not drawn", async () => {
  const href = await host(BELGIUM);
  const z = 9;
  // Well south of the image (Spain), so the window misses it.
  const { x, y } = tileAt(-3.7, 40.4, z);
  assert.equal(await renderStacTile({ z, x, y, spec: rgbOf(href) }), null);
});

test("a brightness gain brightens the same pixels", async () => {
  const href = await host(BELGIUM);
  const z = 9;
  const { x, y } = tileAt(4.8, 51.2, z);
  const plain = rgbOf(href);
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

test("a file with no overview coarse enough is drawn thinned, not left blank", async () => {
  // 2560 pixels across at 0.001 degrees is 2.56 degrees. One zoom-6 tile (5.6 degrees wide) holds
  // all of it, so it needs a window wider than a tile read should be, and the file has no
  // overviews to read instead.
  const z = 6;
  const { x, y } = tileAt(2.2, 50, z);
  const north = lonLatOfPixel(z, x, y, 128, 0).lat;
  const south = lonLatOfPixel(z, x, y, 128, 255).lat;
  const top = north - 0.3;
  assert.ok(top - 2.56 > south, "the file sits inside the tile");
  const href = await host({
    width: 2560,
    height: 2560,
    tile: 256,
    pixelX: 0.001,
    pixelY: 0.001,
    origin: [1, top],
  });
  const rgba = await renderStacTile({ z, x, y, spec: rgbOf(href) });
  assert.ok(rgba, "the tile is drawn");
  let opaque = 0;
  const reds = new Set<number>();
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 255) {
      opaque += 1;
      reds.add(rgba[i]);
    }
  }
  // About a third of the tile is under the file.
  assert.ok(opaque > 256 * 256 * 0.2, "the covered part is painted");
  assert.ok(reds.size > 20, "with the image's values, not a flat fill");
});
