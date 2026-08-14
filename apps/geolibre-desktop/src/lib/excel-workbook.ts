export interface ExcelWorksheet {
  name: string;
  csv: string;
}

/** Convert Excel worksheets to CSV so Add Data can reuse its existing parser. */
export async function readExcelWorksheets(data: ArrayBuffer): Promise<ExcelWorksheet[]> {
  const XLSX = await import("@e965/xlsx");
  const workbook = XLSX.read(data, { type: "array" });

  return workbook.SheetNames.flatMap((name) => {
    const worksheet = workbook.Sheets[name];
    if (!worksheet) return [];
    const csv = XLSX.utils.sheet_to_csv(worksheet, { blankrows: false });
    return csv.trim() ? [{ name, csv }] : [];
  });
}

export function isExcelFile(path: string): boolean {
  return /\.(?:xls|xlsx)$/i.test(path);
}
