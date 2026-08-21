import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature, FeatureCollection } from "geojson";
import {
  readDxfCodepage,
  recodeCadFeatureCollection,
  recodeCadString,
} from "../apps/geolibre-desktop/src/lib/cad-encoding.ts";

const TEXT_ENCODER = new TextEncoder();

/** GBK bytes for `工程名称` (title-block TEXT in the user's DXF). */
const GONGCHENG_GBK = Uint8Array.from([185, 164, 179, 204, 195, 251, 179, 198]);
/** GBK bytes for `集电线路` (Layer field). */
const JIDIAN_GBK = Uint8Array.from([188, 175, 181, 231, 207, 223, 194, 183]);
/** GBK bytes for `×` (U+00D7); Latin-1 mojibake is `¡Á`. */
const TIMES_GBK = Uint8Array.from([161, 193]);
/** GBK bytes for `兴业大平山风电项目`. */
const XINGYE_GBK = Uint8Array.from([
  208, 203, 210, 181, 180, 243, 198, 189, 201, 189, 183, 231, 181, 231, 207, 238, 196, 191,
]);
/** Big5 bytes for `中`. */
const ZHONG_BIG5 = Uint8Array.from([164, 164]);

/**
 * Concatenate byte arrays into one ArrayBuffer-backed view.
 *
 * @param parts The pieces to join, in order.
 * @returns A single buffer containing every part.
 */
function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Encode ASCII/UTF-8 text as bytes.
 *
 * @param text The text to encode.
 * @returns UTF-8 bytes.
 */
function utf8Bytes(text: string): Uint8Array<ArrayBuffer> {
  return TEXT_ENCODER.encode(text);
}

/**
 * Simulate WASM GDAL: each file byte becomes a Latin-1 codepoint in DuckDB.
 * Built with `fromCharCode` rather than `TextDecoder("latin1")`, which the
 * WHATWG encoding spec aliases to Windows-1252 (bytes 0x80–0x9F diverge).
 *
 * @param bytes Raw DXF TEXT bytes (GBK, UTF-8, …).
 * @returns The mojibake string the attribute table would show without recode.
 */
function duckDbLatin1(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

/**
 * Build a minimal ASCII DXF header plus a TEXT entity payload.
 *
 * @param codepage The `$DWGCODEPAGE` value, or omitted to leave the variable out.
 * @param textBytes The group-1 TEXT payload.
 * @param newline The DXF line ending.
 * @param acadver The `$ACADVER` value.
 * @returns The DXF bytes.
 */
function dxfWithText(
  codepage: string | undefined,
  textBytes: Uint8Array,
  newline = "\n",
  acadver = "AC1018",
): Uint8Array<ArrayBuffer> {
  const nl = newline;
  const head = ["  0", "SECTION", "  2", "HEADER", "  9", "$ACADVER", "  1", acadver];
  if (codepage !== undefined) {
    head.push("  9", "$DWGCODEPAGE", "  3", codepage);
  }
  head.push("  0", "ENDSEC", "  0", "TEXT", "  1", "");
  return concatBytes([utf8Bytes(head.join(nl)), textBytes, utf8Bytes(`${nl}  0${nl}EOF${nl}`)]);
}

/**
 * A point feature whose properties match a DXF TEXT row in the attribute table.
 *
 * @param properties The OGR fields (`Text`, `Layer`, …), or null.
 * @returns A GeoJSON Feature.
 */
function textFeature(properties: Record<string, unknown> | null): Feature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [0, 0] },
    properties,
  };
}

describe("readDxfCodepage", () => {
  it("reads ANSI_936 from a Unix-newline DXF header", () => {
    assert.equal(readDxfCodepage(dxfWithText("ANSI_936", utf8Bytes("x"))), "ANSI_936");
  });

  it("reads a CRLF DXF header and uppercases the value", () => {
    const bytes = dxfWithText("ansi_936", utf8Bytes("x"), "\r\n");
    assert.equal(readDxfCodepage(bytes), "ANSI_936");
  });

  it("reads UTF-8 and ANSI_950 $DWGCODEPAGE values", () => {
    assert.equal(readDxfCodepage(dxfWithText("UTF-8", utf8Bytes("x"))), "UTF-8");
    assert.equal(readDxfCodepage(dxfWithText("utf8", utf8Bytes("x"))), "UTF-8");
    assert.equal(readDxfCodepage(dxfWithText("ANSI_950", utf8Bytes("x"))), "ANSI_950");
  });

  it("treats R2007+ as UTF-8 even when $DWGCODEPAGE is still ANSI_936", () => {
    assert.equal(readDxfCodepage(dxfWithText("ANSI_936", utf8Bytes("x"), "\n", "AC1021")), "UTF-8");
    assert.equal(readDxfCodepage(dxfWithText("ANSI_936", utf8Bytes("x"), "\n", "AC1024")), "UTF-8");
    assert.equal(readDxfCodepage(dxfWithText("ANSI_936", utf8Bytes("x"), "\n", "ac1032")), "UTF-8");
    assert.equal(readDxfCodepage(dxfWithText(undefined, utf8Bytes("x"), "\n", "AC1021")), "UTF-8");
  });

  it("honours $DWGCODEPAGE on R2004 and earlier", () => {
    const r2000 = dxfWithText("ANSI_936", utf8Bytes("x"), "\n", "AC1015");
    assert.equal(readDxfCodepage(r2000), "ANSI_936");
    assert.equal(readDxfCodepage(dxfWithText(undefined, utf8Bytes("x"), "\n", "AC1018")), null);
  });

  it("returns null for a binary DXF, empty bytes, or a missing header", () => {
    const magic = utf8Bytes("AutoCAD Binary DXF\r\n\u001a\u0000");
    assert.equal(readDxfCodepage(magic), null);
    assert.equal(readDxfCodepage(new Uint8Array()), null);
    assert.equal(readDxfCodepage(utf8Bytes("  0\nSECTION\n  0\nEOF\n")), null);
  });

  it("ignores an MTEXT entity whose own content reads $DWGCODEPAGE", () => {
    // The variable name only counts under group code 9, inside HEADER. Here it
    // is group-1 entity text in ENTITIES, so the drawing stays unlabelled.
    const bytes = utf8Bytes(
      [
        "  0",
        "SECTION",
        "  2",
        "HEADER",
        "  9",
        "$ACADVER",
        "  1",
        "AC1018",
        "  0",
        "ENDSEC",
        "  0",
        "SECTION",
        "  2",
        "ENTITIES",
        "  0",
        "MTEXT",
        "  1",
        "$DWGCODEPAGE",
        "  3",
        "ANSI_936",
        "  0",
        "ENDSEC",
        "  0",
        "EOF",
        "",
      ].join("\n"),
    );
    assert.equal(readDxfCodepage(bytes), null);
  });

  it("finds $DWGCODEPAGE behind a HEADER larger than 64 KiB", () => {
    // A generator that writes many variables before $DWGCODEPAGE used to push
    // it past the probe, and detection then failed silently.
    const padding: string[] = [];
    for (let i = 0; i < 4000; i += 1) {
      padding.push("  9", `$GEOLIBREPAD${i}`, "  1", "x".repeat(16));
    }
    const bytes = utf8Bytes(
      [
        "  0",
        "SECTION",
        "  2",
        "HEADER",
        "  9",
        "$ACADVER",
        "  1",
        "AC1018",
        ...padding,
        "  9",
        "$DWGCODEPAGE",
        "  3",
        "ANSI_936",
        "  0",
        "ENDSEC",
        "  0",
        "EOF",
        "",
      ].join("\n"),
    );
    assert.ok(bytes.length > 64 * 1024);
    assert.equal(readDxfCodepage(bytes), "ANSI_936");
  });

  it("reads a header behind a UTF-8 BOM", () => {
    const bom = Uint8Array.from([0xef, 0xbb, 0xbf]);
    const bytes = concatBytes([bom, dxfWithText("ANSI_936", utf8Bytes("x"))]);
    assert.equal(readDxfCodepage(bytes), "ANSI_936");
  });

  it("accepts unpadded and zero-padded HEADER group codes", () => {
    const unpadded = [
      "0",
      "SECTION",
      "2",
      "HEADER",
      "9",
      "$ACADVER",
      "1",
      "AC1018",
      "9",
      "$DWGCODEPAGE",
      "3",
      "ANSI_936",
      "0",
      "EOF",
    ].join("\n");
    const padded = [
      "  0",
      "SECTION",
      "  2",
      "HEADER",
      "  9",
      "$ACADVER",
      "001",
      "AC1018",
      "  9",
      "$DWGCODEPAGE",
      "003",
      "GBK",
      "  0",
      "EOF",
    ].join("\n");
    assert.equal(readDxfCodepage(utf8Bytes(unpadded)), "ANSI_936");
    assert.equal(readDxfCodepage(utf8Bytes(padded)), "GBK");
  });
});

describe("recodeCadString", () => {
  it("repairs GBK TEXT that WASM GDAL exposes as Latin-1", () => {
    assert.equal(recodeCadString(duckDbLatin1(GONGCHENG_GBK), "ANSI_936"), "工程名称");
    assert.equal(recodeCadString(duckDbLatin1(JIDIAN_GBK), "GBK"), "集电线路");
    assert.equal(recodeCadString(duckDbLatin1(XINGYE_GBK), "GB2312"), "兴业大平山风电项目");
  });

  it("repairs the GBK multiplication sign shown as ¡Á in the attribute table", () => {
    const cable = concatBytes([utf8Bytes("ZC-YJLV22-26/35kV-3"), TIMES_GBK, utf8Bytes("95mm2")]);
    assert.equal(duckDbLatin1(TIMES_GBK), "¡Á");
    assert.equal(recodeCadString(duckDbLatin1(cable), "ANSI_936"), "ZC-YJLV22-26/35kV-3×95mm2");
  });

  it("repairs UTF-8 TEXT copied as Latin-1 (Ãæè mojibake after a UTF-8 rewrite)", () => {
    const utf8Times = duckDbLatin1(utf8Bytes("×"));
    assert.match(utf8Times, /Ã/);
    assert.equal(recodeCadString(utf8Times, "UTF-8"), "×");
    assert.equal(recodeCadString(duckDbLatin1(utf8Bytes("工程名称")), "UTF-8"), "工程名称");
  });

  it("repairs Big5 TEXT labelled ANSI_950", () => {
    assert.equal(recodeCadString(duckDbLatin1(ZHONG_BIG5), "ANSI_950"), "中");
  });

  it("leaves ASCII, already-Unicode, and unknown-codepage strings unchanged", () => {
    assert.equal(recodeCadString("XZ01", "ANSI_936"), "XZ01");
    assert.equal(recodeCadString("工程名称", "ANSI_936"), "工程名称");
    assert.equal(recodeCadString("Hello—World", "ANSI_936"), "Hello—World");
    assert.equal(recodeCadString("café", "UTF-8"), "café");
    const mojibake = duckDbLatin1(GONGCHENG_GBK);
    assert.equal(recodeCadString(mojibake, null), mojibake);
    assert.equal(recodeCadString(mojibake, "ANSI_9999"), mojibake);
  });

  it("leaves ISO-8859-1 and ASCII drawings byte-identical", () => {
    // WASM GDAL already maps each byte to the matching Latin-1 code point, so
    // the string is correct as-is. Byte 0x92 is the case that would break if
    // these were routed through a `TextDecoder`: WHATWG aliases every
    // `latin1` / `iso-8859-1` label to windows-1252, which decodes it as `’`.
    const latin1 = duckDbLatin1(Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x92]));
    assert.equal(latin1, "caf\u00e9\u0092");
    for (const codepage of ["ISO8859-1", "ISO-8859-1", "ASCII", "US-ASCII"]) {
      assert.equal(recodeCadString(latin1, codepage), latin1);
    }
  });

  it("is idempotent after a successful GBK recode", () => {
    const once = recodeCadString(duckDbLatin1(GONGCHENG_GBK), "ANSI_936");
    assert.equal(recodeCadString(once, "ANSI_936"), "工程名称");
  });
});

describe("recodeCadFeatureCollection", () => {
  it("recodes Text and Layer on every feature", () => {
    const cable = concatBytes([utf8Bytes("ZC-YJLV22-26/35kV-3"), TIMES_GBK, utf8Bytes("95mm2")]);
    const collection: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        textFeature({
          Text: duckDbLatin1(GONGCHENG_GBK),
          Layer: duckDbLatin1(JIDIAN_GBK),
          EntityHandle: "2A14",
          PaperSpace: 0,
        }),
        textFeature({ Text: duckDbLatin1(cable), Layer: "0" }),
      ],
    };
    const recoded = recodeCadFeatureCollection(collection, "ANSI_936");
    assert.equal(recoded.features[0]?.properties?.Text, "工程名称");
    assert.equal(recoded.features[0]?.properties?.Layer, "集电线路");
    assert.equal(recoded.features[0]?.properties?.EntityHandle, "2A14");
    assert.equal(recoded.features[0]?.properties?.PaperSpace, 0);
    assert.equal(recoded.features[1]?.properties?.Text, "ZC-YJLV22-26/35kV-3×95mm2");
  });

  it("does not mutate the input collection", () => {
    const original = duckDbLatin1(GONGCHENG_GBK);
    const collection: FeatureCollection = {
      type: "FeatureCollection",
      features: [textFeature({ Text: original })],
    };
    const recoded = recodeCadFeatureCollection(collection, "ANSI_936");
    assert.notEqual(recoded, collection);
    assert.equal(collection.features[0]?.properties?.Text, original);
    assert.equal(recoded.features[0]?.properties?.Text, "工程名称");
  });

  it("keeps null properties and leaves geometry on the same object", () => {
    const geometry = { type: "Point" as const, coordinates: [1, 2] };
    const collection: FeatureCollection = {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry, properties: null }],
    };
    const recoded = recodeCadFeatureCollection(collection, "ANSI_936");
    assert.equal(recoded.features[0]?.properties, null);
    assert.equal(recoded.features[0]?.geometry, geometry);
  });

  it("returns the same collection when the codepage is missing or unknown", () => {
    const collection: FeatureCollection = {
      type: "FeatureCollection",
      features: [textFeature({ Text: duckDbLatin1(GONGCHENG_GBK) })],
    };
    assert.equal(recodeCadFeatureCollection(collection, null), collection);
    assert.equal(recodeCadFeatureCollection(collection, "ANSI_9999"), collection);
  });
});
