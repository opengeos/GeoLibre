import { useAppStore } from "@geolibre/core";
import { Button, Label, Select } from "@geolibre/ui";
import { FileUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { parseDelimitedTextLayer } from "../../lib/delimited-text";
import { type ExcelWorksheet, isExcelFile, readExcelWorksheets } from "../../lib/excel-workbook";
import { openLocalDataFileWithFallback } from "../../lib/tauri-io";
import { createBaseLayer, fileNameFromPath, layerNameFromPath } from "../layout/add-data/helpers";

interface JoinTableFileInputProps {
  targetLayerId: string;
  onImport: (layerId: string) => void;
}

/** Import attribute rows without interpreting any columns as coordinates. */
export function JoinTableFileInput({ targetLayerId, onImport }: JoinTableFileInputProps) {
  const { t } = useTranslation();
  const [file, setFile] = useState<{
    path: string;
    text: string;
    worksheets?: ExcelWorksheet[];
  } | null>(null);
  const [sheet, setSheet] = useState("");
  const [delimiter, setDelimiter] = useState(",");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const chooseFile = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await openLocalDataFileWithFallback({
        filters: [
          {
            name: t("addData.delimitedText.fileFilter"),
            extensions: ["csv", "tsv", "txt", "xls", "xlsx"],
          },
        ],
        accept: ".csv,.tsv,.txt,.xls,.xlsx",
        binaryExtensions: ["xls", "xlsx"],
        readText: true,
      });
      if (!result) return;
      const worksheets =
        isExcelFile(result.path) && result.data
          ? await readExcelWorksheets(result.data)
          : undefined;
      if (worksheets && worksheets.length === 0) {
        throw new Error(t("addData.delimitedText.errorWorkbookEmpty"));
      }
      if (!worksheets && !result.text) {
        throw new Error(t("addData.delimitedText.errorFileMissing"));
      }
      if (!mounted.current) return;
      setFile({ path: result.path, text: result.text ?? "", worksheets });
      setSheet(worksheets?.[0]?.name ?? "");
      setDelimiter(/\.tsv$/i.test(result.path) ? "\t" : ",");
    } catch (err) {
      if (mounted.current)
        setError(err instanceof Error ? err.message : t("addData.delimitedText.readError"));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const importTable = () => {
    if (!file) return;
    setError(null);
    try {
      const text =
        file.worksheets?.find((worksheet) => worksheet.name === sheet)?.toCsv() ?? file.text;
      const result = parseDelimitedTextLayer(text, {
        delimiter: file.worksheets ? "," : delimiter,
        latitudeField: "",
        longitudeField: "",
      });
      const store = useAppStore.getState();
      if (!store.layers.some((layer) => layer.id === targetLayerId)) return;
      const name = layerNameFromPath(file.path, t("addData.delimitedText.defaultName"));
      // Built with no vector styling data on purpose: a non-spatial attribute
      // table draws nothing, so it stays on the flat defaults rather than
      // reserving a palette color no map ever shows — the same choice the
      // Delimited Text source makes for a table.
      const layer = {
        ...createBaseLayer(
          file.worksheets ? `${name} — ${sheet}` : name,
          "geojson",
          { type: "geojson" },
          {
            isTable: true,
            fields: result.fields,
            featureCount: result.totalRows,
          },
        ),
        // Embed the imported rows in the project; a local file path is not a
        // reloadable GeoJSON source (especially for a selected Excel sheet).
        geojson: result.data,
      };
      const { selectedFeatureId, selectedFeatureIds } = store;
      store.addLayer(layer);
      // Adding a layer selects it; keep the join draft on its original target.
      store.selectLayer(targetLayerId);
      // `selectLayer` also clears the feature selection, but the target layer
      // itself never changed, so put back whatever was selected before.
      if (selectedFeatureIds.length > 0) {
        store.selectFeatures(selectedFeatureIds, selectedFeatureId);
      }
      onImport(layer.id);
      setFile(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("addData.delimitedText.readError"));
    }
  };

  return (
    <div className="space-y-2">
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void chooseFile()}>
        <FileUp className="h-3.5 w-3.5" />
        {t("addData.common.chooseFile")}
      </Button>
      <span className="ms-2 text-xs text-muted-foreground">
        {t("addData.delimitedText.fileFilter")}
      </span>
      {file && (
        <>
          <p className="break-all text-xs">{fileNameFromPath(file.path)}</p>
          {file.worksheets ? (
            <div className="space-y-1">
              <Label htmlFor={`join-sheet-${targetLayerId}`}>
                {t("addData.delimitedText.worksheet")}
              </Label>
              <Select
                id={`join-sheet-${targetLayerId}`}
                value={sheet}
                onChange={(event) => setSheet(event.target.value)}
              >
                {file.worksheets.map((worksheet) => (
                  <option key={worksheet.name} value={worksheet.name}>
                    {worksheet.name}
                  </option>
                ))}
              </Select>
            </div>
          ) : (
            <div className="space-y-1">
              <Label htmlFor={`join-delimiter-${targetLayerId}`}>
                {t("addData.delimitedText.delimiter")}
              </Label>
              <Select
                id={`join-delimiter-${targetLayerId}`}
                value={delimiter}
                onChange={(event) => setDelimiter(event.target.value)}
              >
                <option value=",">{t("addData.delimitedText.delimiterComma")}</option>
                <option value={"\t"}>{t("addData.delimitedText.delimiterTab")}</option>
                <option value=";">{t("addData.delimitedText.delimiterSemicolon")}</option>
                <option value="|">{t("addData.delimitedText.delimiterPipe")}</option>
              </Select>
            </div>
          )}
          <Button variant="outline" size="sm" disabled={busy} onClick={importTable}>
            {t("addData.shared.addLayer")}
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
