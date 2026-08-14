import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "@e965/xlsx";
import { isExcelFile, readExcelWorksheets } from "../apps/geolibre-desktop/src/lib/excel-workbook";

for (const bookType of ["xls", "xlsx"] as const) {
  test(`reads ${bookType} worksheets as delimited text`, async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["site", "X", "Y"],
        ["Alpha", -77.0365, 38.8977],
      ]),
      "Survey",
    );
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([]), "Empty");
    const bytes = XLSX.write(workbook, { bookType, type: "array" });

    const worksheets = await readExcelWorksheets(bytes);

    assert.deepEqual(
      worksheets.map((worksheet) => ({ name: worksheet.name, csv: worksheet.toCsv() })),
      [{ name: "Survey", csv: "site,X,Y\nAlpha,-77.0365,38.8977" }],
    );
  });
}

test("recognizes Excel extensions case-insensitively", () => {
  assert.equal(isExcelFile("survey.xls"), true);
  assert.equal(isExcelFile("SURVEY.XLSX"), true);
  assert.equal(isExcelFile("survey.csv"), false);
});
