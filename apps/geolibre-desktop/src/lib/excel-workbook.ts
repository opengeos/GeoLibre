export interface ExcelWorksheet {
  name: string;
  toCsv: () => string;
}

/** Read workbook metadata and lazily convert a selected sheet to CSV. */
export async function readExcelWorksheets(data: ArrayBuffer): Promise<ExcelWorksheet[]> {
  const XLSX = await import("@e965/xlsx");
  // `cellDates` keeps date columns from reaching `rawNumbers` below as bare
  // serial numbers (45305.79…) instead of the date the user sees in Excel.
  const workbook = XLSX.read(data, { type: "array", cellDates: true });

  return workbook.SheetNames.flatMap((name) => {
    const worksheet = workbook.Sheets[name];
    const hasValues =
      worksheet &&
      Object.entries(worksheet).some(([cell, entry]) => {
        if (cell.startsWith("!")) return false;
        const { f: formula, v: value } = entry as { f?: string; v?: unknown };
        if (formula?.trim()) return true;
        return typeof value === "string" ? value.trim().length > 0 : value != null;
      });
    if (!worksheet || !hasValues) return [];
    // Retrieving the columns and importing the layer each ask for the CSV, so
    // cache it rather than walking every row of a large sheet twice.
    let csv: string | undefined;
    return [
      {
        name,
        // `rawNumbers` keeps a display format (thousands separators, rounding)
        // from reaching the delimited-text parser as `1,234.5678` or a
        // truncated coordinate.
        toCsv: () =>
          (csv ??= XLSX.utils.sheet_to_csv(worksheet, { blankrows: false, rawNumbers: true })),
      },
    ];
  });
}

export function isExcelFile(path: string): boolean {
  return /\.(?:xls|xlsx)$/i.test(path);
}

/**
 * Whether downloaded bytes are an Excel workbook, by signature: an `.xlsx` is
 * a ZIP archive (`PK\x03\x04`) and a legacy `.xls` an OLE compound document
 * (`D0 CF 11 E0`). Lets a URL without an `.xlsx` suffix still be read as a
 * workbook rather than decoded as text. No delimited text file starts with
 * either signature.
 *
 * @param bytes - The downloaded payload.
 * @returns True when the payload is a ZIP or OLE container.
 */
export function isExcelBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  const ole = bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  return zip || ole;
}

/** A URL's path, so a query string cannot hide its extension; the input when it does not parse. */
function urlPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * Interprets a download from the Delimited text URL source. An Excel workbook
 * (by its URL's extension or its bytes) is read as worksheets, since decoding
 * it as text would yield the ZIP's bytes as CSV; anything else is UTF-8 text.
 *
 * @param url - The URL the bytes came from.
 * @param buffer - The downloaded payload.
 * @returns The workbook's non-empty worksheets, or the decoded text.
 */
export async function readDelimitedTextDownload(
  url: string,
  buffer: ArrayBuffer,
): Promise<{ worksheets: ExcelWorksheet[] } | { text: string }> {
  const bytes = new Uint8Array(buffer);
  if (isExcelFile(urlPathname(url)) || isExcelBytes(bytes)) {
    return { worksheets: await readExcelWorksheets(buffer) };
  }
  return { text: new TextDecoder().decode(bytes) };
}
