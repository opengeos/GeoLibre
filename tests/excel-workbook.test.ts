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
        ["site", "X", "Y", "surveyed"],
        ["Alpha", -77.0365, 38.8977, new Date(2024, 0, 15)],
      ]),
      "Survey",
    );
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([]), "Empty");
    const formulaSheet = XLSX.utils.aoa_to_sheet([[null]]);
    formulaSheet.A1 = { f: "1+1", t: "n" };
    formulaSheet["!ref"] = "A1";
    XLSX.utils.book_append_sheet(workbook, formulaSheet, "Formula");
    // A format that rounds what Excel displays, so the assertion below fails if
    // the CSV ever falls back to formatted text instead of the raw coordinate.
    const surveySheet = workbook.Sheets.Survey;
    if (surveySheet?.B2) surveySheet.B2.z = "0.00";
    const bytes = XLSX.write(workbook, { bookType, type: "array" });

    const worksheets = await readExcelWorksheets(bytes);

    assert.deepEqual(
      worksheets.map((worksheet) => ({ name: worksheet.name, csv: worksheet.toCsv() })),
      [
        // The date stays a date rather than its serial number, even though
        // every other number comes through raw.
        { name: "Survey", csv: "site,X,Y,surveyed\nAlpha,-77.0365,38.8977,1/15/24" },
        ...(bookType === "xlsx" ? [{ name: "Formula", csv: "=1+1" }] : []),
      ],
    );
  });
}

test("recognizes Excel extensions case-insensitively", () => {
  assert.equal(isExcelFile("survey.xls"), true);
  assert.equal(isExcelFile("SURVEY.XLSX"), true);
  assert.equal(isExcelFile("survey.csv"), false);
});
