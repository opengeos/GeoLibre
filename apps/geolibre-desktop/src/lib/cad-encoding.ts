/**
 * Repair DXF string fields after DuckDB-WASM `ST_Read`.
 *
 * AutoCAD TEXT in R2004 and earlier is stored in `$DWGCODEPAGE`; R2007
 * (`AC1021`) and later is UTF-8. Desktop GDAL recodes to UTF-8; WASM GDAL has
 * no iconv, so each file byte becomes a Latin-1 character. Recode those
 * strings — recover the original bytes, then decode with the drawing
 * codepage — at the GeoJSON boundary. Rewriting the file as UTF-8 does not
 * help: WASM GDAL still copies bytes as Latin-1. Binary DXF is left unchanged.
 *
 * Kept free of the DuckDB-WASM import so `node --test` can cover it without
 * pulling the engine into the coverage denominator.
 */

import type { Feature, FeatureCollection, GeoJsonProperties } from "geojson";

/**
 * How much of the file to decode when looking for the HEADER section.
 *
 * `$ACADVER` and `$DWGCODEPAGE` are the first two variables AutoCAD writes, so
 * a much smaller probe would do for its own files — but a generator that emits
 * an unusually large HEADER before them would fail *silently*, leaving the
 * mojibake unrecoded with no error. A megabyte is far past any real HEADER
 * while still costing one bounded decode, and {@link readDxfHeaderVariables}
 * stops at the section's `ENDSEC`, so the extra room is never walked.
 */
const HEADER_PROBE_BYTES = 1024 * 1024;
const BINARY_DXF_MAGIC = "AutoCAD Binary DXF";
/** `$ACADVER` numeric suffix at which DXF switched from codepage to UTF-8. */
const UTF8_DXF_VERSION = 1021;

/**
 * AutoCAD `$DWGCODEPAGE` → WHATWG `TextDecoder` label.
 *
 * `ISO8859-1` / `ISO-8859-1` / `ASCII` / `US-ASCII` are deliberately absent:
 * WASM GDAL already turns each file byte into the matching Latin-1 code point,
 * which *is* the correct Unicode for those codepages, so recoding has nothing
 * to repair. Mapping them through `TextDecoder` would instead corrupt bytes
 * 0x80–0x9F, because the WHATWG Encoding Standard aliases every `latin1` /
 * `iso-8859-1` label to windows-1252, where that range holds printable
 * characters rather than ISO-8859-1's C1 controls. `ANSI_1252` is a different
 * matter and stays mapped: there the file really is windows-1252, so those
 * bytes do need recoding.
 */
const CODEPAGE_LABELS: Record<string, string> = {
  "UTF-8": "utf-8",
  UTF8: "utf-8",
  ANSI_936: "gb18030",
  GBK: "gb18030",
  GB2312: "gb18030",
  GB18030: "gb18030",
  ANSI_950: "big5",
  BIG5: "big5",
  ANSI_932: "shift_jis",
  SHIFT_JIS: "shift_jis",
  // `euc-kr` is the full Windows-949 (UHC) superset here, not bare KS X 1001:
  // WHATWG defines the euc-kr decoder over lead 0x81-0xFE / trail 0x41-0xFE and
  // lists `windows-949` as one of its labels, so a browser decodes the
  // UHC-only syllables too (verified in Chromium: 0x81 0x41 -> 갂). Node's
  // ICU-backed `TextDecoder` is the narrower KS X 1001 and rejects those bytes,
  // so cover Korean recoding in an `e2e/` spec rather than under `node --test`.
  ANSI_949: "euc-kr",
  ANSI_1252: "windows-1252",
  ANSI_1250: "windows-1250",
  ANSI_1251: "windows-1251",
  ANSI_1253: "windows-1253",
  ANSI_1254: "windows-1254",
  ANSI_1255: "windows-1255",
  ANSI_1256: "windows-1256",
  ANSI_1257: "windows-1257",
  ANSI_1258: "windows-1258",
};

/**
 * Decode a Latin-1 prefix so ASCII DXF headers can be scanned.
 *
 * The `latin1` label is windows-1252 in disguise (see {@link CODEPAGE_LABELS}),
 * which is harmless here: the header variables and values this scans are ASCII.
 * A leading UTF-8 BOM (`EF BB BF`, which that decode turns into `ï»¿`) is
 * dropped so it cannot glue itself to the file's first group code — a DXF
 * re-saved as UTF-8 by a text editor is exactly the case this module exists for.
 *
 * @param bytes The DXF file bytes.
 * @returns The first {@link HEADER_PROBE_BYTES} decoded as Latin-1.
 */
function headerLatin1(bytes: Uint8Array): string {
  const text = new TextDecoder("latin1").decode(
    bytes.subarray(0, Math.min(bytes.length, HEADER_PROBE_BYTES)),
  );
  return text.replace(/^(?:\uFEFF|ï»¿)/, "");
}

/**
 * True when the buffer is a binary DXF (not the ASCII/ANSI text form).
 *
 * @param bytes The file bytes.
 * @returns True when the AutoCAD binary-DXF magic is present.
 */
function isBinaryDxf(bytes: Uint8Array): boolean {
  if (bytes.length < BINARY_DXF_MAGIC.length) return false;
  for (let i = 0; i < BINARY_DXF_MAGIC.length; i += 1) {
    if (bytes[i] !== BINARY_DXF_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

/** One HEADER variable: its value records, keyed by DXF group code. */
type DxfHeaderVariable = Map<number, string>;

/**
 * Parse the HEADER variables out of an ASCII DXF prefix.
 *
 * DXF is a flat stream of (group code, value) line pairs. A HEADER variable is
 * introduced by a group-9 record naming it, followed by the value records that
 * belong to it. Walking those pairs — rather than pattern-matching the text —
 * is what keeps an entity from impersonating a variable: an `MTEXT` whose own
 * content reads `$DWGCODEPAGE` sits under group 1, not group 9, and the scan
 * stops at the HEADER section's `ENDSEC` before reaching ENTITIES anyway.
 *
 * A pair whose group code is not a number is skipped rather than treated as a
 * value; pair alignment is fixed by the format, so one unreadable code does not
 * desync the ones after it.
 *
 * @param header Latin-1 text of the file prefix.
 * @returns Each variable name (uppercased, without `$`) mapped to its records.
 */
function readDxfHeaderVariables(header: string): Map<string, DxfHeaderVariable> {
  const lines = header.split(/\r?\n/);
  const variables = new Map<string, DxfHeaderVariable>();
  let awaitingSectionName = false;
  let inHeader = false;
  let current: DxfHeaderVariable | null = null;

  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i]!.trim(), 10);
    const value = lines[i + 1]!.trim();
    if (!Number.isInteger(code)) continue;

    if (code === 0 && value.toUpperCase() === "SECTION") {
      awaitingSectionName = true;
      inHeader = false;
      current = null;
      continue;
    }
    if (awaitingSectionName) {
      // The `2` record right after `0/SECTION` names the section.
      if (code === 2) {
        inHeader = value.toUpperCase() === "HEADER";
        awaitingSectionName = false;
      }
      continue;
    }
    if (!inHeader) continue;
    // HEADER is the first section, so its end is the end of anything readable.
    if (code === 0 && value.toUpperCase() === "ENDSEC") break;

    if (code === 9) {
      const name = value.startsWith("$") ? value.slice(1).toUpperCase() : "";
      if (!name) {
        current = null;
        continue;
      }
      current = variables.get(name) ?? new Map<number, string>();
      variables.set(name, current);
      continue;
    }
    // First record of a given code wins, so a repeated variable cannot shadow
    // the value AutoCAD wrote first.
    if (current && !current.has(code)) current.set(code, value);
  }
  return variables;
}

/**
 * Read one HEADER variable's value record.
 *
 * @param variables From {@link readDxfHeaderVariables}.
 * @param name The variable without `$`, such as `ACADVER`.
 * @param groupCode The DXF group code of the value record (`1` or `3`).
 * @returns The trimmed value, or null when the variable or record is absent.
 */
function readDxfHeaderValue(
  variables: Map<string, DxfHeaderVariable>,
  name: string,
  groupCode: number,
): string | null {
  return variables.get(name)?.get(groupCode) || null;
}

/**
 * True when `$ACADVER` is R2007 or later (UTF-8 DXF).
 *
 * @param acadver A value such as `AC1021`.
 * @returns True when the numeric suffix is >= {@link UTF8_DXF_VERSION}.
 */
function isUtf8DxfVersion(acadver: string): boolean {
  const match = /^AC(\d+)$/i.exec(acadver.trim());
  return match !== null && Number(match[1]) >= UTF8_DXF_VERSION;
}

/**
 * Map an AutoCAD codepage name to a `TextDecoder` label, if supported.
 *
 * @param codepage An uppercased `$DWGCODEPAGE` value.
 * @returns A WHATWG encoding label, or null when unknown/unsupported.
 */
function decoderLabelForCodepage(codepage: string): string | null {
  const mapped = CODEPAGE_LABELS[codepage];
  if (!mapped) return null;
  try {
    new TextDecoder(mapped);
    return mapped;
  } catch {
    return null;
  }
}

/**
 * Normalize a `$DWGCODEPAGE` value to a CODEPAGE_LABELS key.
 *
 * @param raw A token such as `ansi_936` or `utf8`.
 * @returns The uppercased key, with `UTF8` folded to `UTF-8`.
 */
function normalizeCodepageToken(raw: string): string {
  const upper = raw.trim().toUpperCase();
  return upper === "UTF8" ? "UTF-8" : upper;
}

/**
 * Read the drawing codepage from an ASCII DXF header.
 *
 * R2007+ (`$ACADVER` >= AC1021) is UTF-8 even when `$DWGCODEPAGE` still names
 * a legacy ANSI_* page. Earlier versions use `$DWGCODEPAGE`. Binary DXF and
 * files with neither variable are left unlabelled.
 *
 * @param bytes The file bytes (must be read before DuckDB detaches the buffer).
 * @returns An AutoCAD codepage name, or null when recoding should not run.
 */
export function readDxfCodepage(bytes: Uint8Array): string | null {
  if (bytes.length === 0 || isBinaryDxf(bytes)) return null;
  const variables = readDxfHeaderVariables(headerLatin1(bytes));
  const acadver = readDxfHeaderValue(variables, "ACADVER", 1);
  if (acadver && isUtf8DxfVersion(acadver)) return "UTF-8";
  const codepage = readDxfHeaderValue(variables, "DWGCODEPAGE", 3);
  return codepage ? normalizeCodepageToken(codepage) : null;
}

/**
 * Rebuild the DXF bytes WASM GDAL copied into a JS string as Latin-1.
 *
 * @param value A DuckDB string field.
 * @returns The original bytes, or null when `value` is already real Unicode.
 */
function duckDbStringBytes(value: string): Uint8Array | null {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code > 255) return null;
    bytes[i] = code;
  }
  return bytes;
}

/**
 * Recode one DXF string with an already-constructed decoder.
 *
 * @param value The raw DuckDB/OGR string (or already-correct Unicode).
 * @param decoder A `TextDecoder` for the drawing codepage.
 * @returns Unicode text, or `value` when recoding does not apply.
 */
function recodeWithDecoder(value: string, decoder: TextDecoder): string {
  if (!value) return value;
  const bytes = duckDbStringBytes(value);
  if (!bytes) return value;
  try {
    return decoder.decode(bytes);
  } catch {
    return value;
  }
}

/**
 * Recode one DXF attribute that WASM GDAL exposed as Latin-1 mojibake.
 *
 * @param value The raw DuckDB/OGR string (or already-correct Unicode).
 * @param codepage From {@link readDxfCodepage}, or null.
 * @returns Unicode text, or `value` when recoding does not apply.
 */
export function recodeCadString(value: string, codepage: string | null): string {
  if (!value || !codepage) return value;
  const label = decoderLabelForCodepage(codepage);
  if (!label) return value;
  return recodeWithDecoder(value, new TextDecoder(label, { fatal: true }));
}

/**
 * Recode string properties on one feature.
 *
 * @param properties The feature properties object, or null.
 * @param decoder A `TextDecoder` for the drawing codepage.
 * @returns Properties with DXF strings recoded; non-strings left unchanged.
 */
function recodeCadProperties(
  properties: GeoJsonProperties,
  decoder: TextDecoder,
): GeoJsonProperties {
  if (!properties) return properties;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    next[key] = typeof value === "string" ? recodeWithDecoder(value, decoder) : value;
  }
  return next;
}

/**
 * Recode string properties on every feature in a DXF-derived collection.
 *
 * @param collection The FeatureCollection `ST_Read` materialized.
 * @param codepage From {@link readDxfCodepage}, or null.
 * @returns A new collection when recoding ran; `collection` when it did not.
 */
export function recodeCadFeatureCollection(
  collection: FeatureCollection,
  codepage: string | null,
): FeatureCollection {
  const label = codepage ? decoderLabelForCodepage(codepage) : null;
  if (!label) return collection;
  const decoder = new TextDecoder(label, { fatal: true });
  return {
    ...collection,
    features: collection.features.map((feature: Feature) => ({
      ...feature,
      properties: recodeCadProperties(feature.properties, decoder),
    })),
  };
}
