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
