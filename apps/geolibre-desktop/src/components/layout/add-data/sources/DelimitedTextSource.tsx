import { Button, Input, Label, Select } from "@geolibre/ui";
import { Columns3, FileUp } from "lucide-react";
import { useMemo, useState } from "react";
import {
  parseDelimitedTextFields,
  parseDelimitedTextLayer,
} from "../../../../lib/delimited-text";
import { openLocalDataFileWithFallback } from "../../../../lib/tauri-io";
import {
  DEFAULT_DELIMITED_TEXT_LATITUDE_FIELD,
  DEFAULT_DELIMITED_TEXT_LONGITUDE_FIELD,
  DEFAULT_DELIMITED_TEXT_URL,
} from "../constants";
import {
  createBaseLayer,
  errorMessage,
  fileNameFromPath,
  inferDelimitedTextField,
  layerNameFromPath,
  resolveDelimitedTextDelimiter,
} from "../helpers";
import { AddDataSourceForm, useAddDataSource } from "../shared";
import type { DelimitedTextDelimiter, DelimitedTextMode } from "../types";

export function DelimitedTextSource() {
  const source = useAddDataSource("Delimited Text Layer");
  const [delimitedTextMode, setDelimitedTextMode] =
    useState<DelimitedTextMode>("url");
  const [delimitedTextUrl, setDelimitedTextUrl] = useState(
    DEFAULT_DELIMITED_TEXT_URL,
  );
  const [delimitedTextDelimiter, setDelimitedTextDelimiter] =
    useState<DelimitedTextDelimiter>("comma");
  const [delimitedTextCustomDelimiter, setDelimitedTextCustomDelimiter] =
    useState("");
  const [delimitedTextLatitudeField, setDelimitedTextLatitudeField] = useState(
    DEFAULT_DELIMITED_TEXT_LATITUDE_FIELD,
  );
  const [delimitedTextLongitudeField, setDelimitedTextLongitudeField] =
    useState(DEFAULT_DELIMITED_TEXT_LONGITUDE_FIELD);
  const [delimitedTextFields, setDelimitedTextFields] = useState<string[]>([]);
  const [delimitedTextColumnsStatus, setDelimitedTextColumnsStatus] = useState<
    string | null
  >(null);
  const [
    isRetrievingDelimitedTextColumns,
    setIsRetrievingDelimitedTextColumns,
  ] = useState(false);
  const [selectedDelimitedText, setSelectedDelimitedText] = useState<{
    path: string;
    text: string;
  } | null>(null);

  const resetDelimitedTextColumns = () => {
    setDelimitedTextFields([]);
    setDelimitedTextColumnsStatus(null);
  };

  const handleDelimitedTextModeChange = (mode: DelimitedTextMode) => {
    setDelimitedTextMode(mode);
    setSelectedDelimitedText(null);
    resetDelimitedTextColumns();
    if (mode === "url" && !delimitedTextUrl.trim()) {
      setDelimitedTextUrl(DEFAULT_DELIMITED_TEXT_URL);
    }
  };

  const readDelimitedTextSource = async (): Promise<{
    sourcePath: string;
    text: string;
  }> => {
    if (delimitedTextMode === "file") {
      if (!selectedDelimitedText) {
        throw new Error("Choose a delimited text file.");
      }
      return {
        sourcePath: selectedDelimitedText.path,
        text: selectedDelimitedText.text,
      };
    }

    const sourcePath = delimitedTextUrl.trim();
    if (!sourcePath) throw new Error("Enter a delimited text URL.");

    const response = await fetch(sourcePath);
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    return {
      sourcePath,
      text: await response.text(),
    };
  };

  const handleChooseDelimitedText = async () => {
    source.setError(null);
    try {
      const result = await openLocalDataFileWithFallback({
        filters: [
          {
            name: "Delimited text",
            extensions: ["csv", "tsv", "txt", "dat"],
          },
        ],
        accept: ".csv,.tsv,.txt,.dat",
        readText: true,
      });
      if (!result) return;
      if (!result.text) throw new Error("Delimited text file data is missing.");
      setSelectedDelimitedText({
        path: result.path,
        text: result.text,
      });
      resetDelimitedTextColumns();
      source.setLayerName((current) =>
        current.trim() && current !== "Delimited Text Layer"
          ? current
          : layerNameFromPath(result.path, "Delimited Text Layer"),
      );
    } catch (err) {
      source.setError(errorMessage(err, "Could not read delimited text file."));
    }
  };

  const handleRetrieveDelimitedTextColumns = async () => {
    source.setError(null);
    setDelimitedTextColumnsStatus(null);
    setIsRetrievingDelimitedTextColumns(true);

    try {
      const delimiter = resolveDelimitedTextDelimiter(
        delimitedTextDelimiter,
        delimitedTextCustomDelimiter,
      );
      const { text } = await readDelimitedTextSource();
      const fields = parseDelimitedTextFields(text, delimiter);
      setDelimitedTextFields(fields);
      setDelimitedTextLongitudeField((current) =>
        inferDelimitedTextField(fields, current, [
          "longitude",
          "lon",
          "lng",
          "long",
          "x",
          "xcoord",
          "x_coord",
        ]),
      );
      setDelimitedTextLatitudeField((current) =>
        inferDelimitedTextField(fields, current, [
          "latitude",
          "lat",
          "y",
          "ycoord",
          "y_coord",
        ]),
      );
      setDelimitedTextColumnsStatus(
        `Retrieved ${fields.length} column${fields.length === 1 ? "" : "s"}.`,
      );
    } catch (err) {
      source.setError(errorMessage(err, "Could not retrieve column names."));
      setDelimitedTextFields([]);
    } finally {
      setIsRetrievingDelimitedTextColumns(false);
    }
  };

  const handleSubmit = source.runSubmit(async () => {
    const name = source.layerName.trim() || "Delimited Text Layer";
    const delimiter = resolveDelimitedTextDelimiter(
      delimitedTextDelimiter,
      delimitedTextCustomDelimiter,
    );
    const { sourcePath, text } = await readDelimitedTextSource();
    if (!text) throw new Error("Delimited text data is missing.");

    const result = parseDelimitedTextLayer(text, {
      delimiter,
      latitudeField: delimitedTextLatitudeField,
      longitudeField: delimitedTextLongitudeField,
    });
    source.addAndClose(
      {
        ...createBaseLayer(
          name,
          "geojson",
          {
            type: "geojson",
            url: sourcePath,
          },
          {
            delimiter,
            featureCount: result.data.features.length,
            fields: result.fields,
            latitudeField: delimitedTextLatitudeField.trim(),
            longitudeField: delimitedTextLongitudeField.trim(),
            skippedRows: result.skippedRows,
            sourceKind: "delimited-text",
            totalRows: result.totalRows,
          },
        ),
        geojson: result.data,
        sourcePath,
      },
      { fit: true },
    );
  });

  const delimitedTextFieldOptions = useMemo(
    () =>
      Array.from(
        new Set(
          [
            ...delimitedTextFields,
            delimitedTextLongitudeField,
            delimitedTextLatitudeField,
          ].filter((field) => field.trim()),
        ),
      ),
    [
      delimitedTextFields,
      delimitedTextLatitudeField,
      delimitedTextLongitudeField,
    ],
  );

  const missingCustomDelimiter =
    delimitedTextDelimiter === "custom" && !delimitedTextCustomDelimiter.trim();

  return (
    <AddDataSourceForm
      layerName={source.layerName}
      onLayerNameChange={source.setLayerName}
      beforeLayerId={source.beforeLayerId}
      onBeforeLayerIdChange={source.setBeforeLayerId}
      onSubmit={handleSubmit}
      error={source.error}
      submitDisabled={
        source.isSubmitting ||
        isRetrievingDelimitedTextColumns ||
        missingCustomDelimiter
      }
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="delimited-text-mode">Source type</Label>
          <Select
            id="delimited-text-mode"
            value={delimitedTextMode}
            onChange={(event) =>
              handleDelimitedTextModeChange(
                event.target.value as DelimitedTextMode,
              )
            }
          >
            <option value="url">Delimited text URL</option>
            <option value="file">Delimited text file</option>
          </Select>
        </div>

        {delimitedTextMode === "file" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={handleChooseDelimitedText}
            >
              <FileUp className="mr-2 h-3.5 w-3.5" />
              Choose file
            </Button>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {selectedDelimitedText
                ? fileNameFromPath(selectedDelimitedText.path)
                : "No file selected"}
            </span>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="delimited-text-url">Delimited text URL</Label>
            <Input
              id="delimited-text-url"
              placeholder="https://example.com/data.csv"
              value={delimitedTextUrl}
              onChange={(event) => {
                setDelimitedTextUrl(event.target.value);
                resetDelimitedTextColumns();
              }}
            />
          </div>
        )}

        <Button
          type="button"
          variant="outline"
          onClick={handleRetrieveDelimitedTextColumns}
          disabled={
            source.isSubmitting ||
            isRetrievingDelimitedTextColumns ||
            missingCustomDelimiter ||
            (delimitedTextMode === "file" && !selectedDelimitedText) ||
            (delimitedTextMode === "url" && !delimitedTextUrl.trim())
          }
        >
          <Columns3 className="mr-2 h-3.5 w-3.5" />
          {isRetrievingDelimitedTextColumns
            ? "Retrieving..."
            : "Retrieve columns"}
        </Button>
        {delimitedTextColumnsStatus ? (
          <p className="text-xs text-muted-foreground">
            {delimitedTextColumnsStatus}
          </p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="delimited-text-delimiter">Delimiter</Label>
            <Select
              id="delimited-text-delimiter"
              value={delimitedTextDelimiter}
              onChange={(event) => {
                setDelimitedTextDelimiter(
                  event.target.value as DelimitedTextDelimiter,
                );
                resetDelimitedTextColumns();
              }}
            >
              <option value="comma">Comma</option>
              <option value="tab">Tab</option>
              <option value="semicolon">Semicolon</option>
              <option value="pipe">Pipe</option>
              <option value="custom">Custom</option>
            </Select>
          </div>
          {delimitedTextDelimiter === "custom" ? (
            <div className="space-y-1.5">
              <Label htmlFor="delimited-text-custom-delimiter">
                Custom delimiter
              </Label>
              <Input
                id="delimited-text-custom-delimiter"
                value={delimitedTextCustomDelimiter}
                onChange={(event) => {
                  setDelimitedTextCustomDelimiter(event.target.value);
                  resetDelimitedTextColumns();
                }}
              />
            </div>
          ) : null}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="delimited-text-longitude">Longitude field</Label>
            <Select
              id="delimited-text-longitude"
              value={delimitedTextLongitudeField}
              onChange={(event) =>
                setDelimitedTextLongitudeField(event.target.value)
              }
            >
              {delimitedTextFieldOptions.map((field) => (
                <option key={field} value={field}>
                  {field}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="delimited-text-latitude">Latitude field</Label>
            <Select
              id="delimited-text-latitude"
              value={delimitedTextLatitudeField}
              onChange={(event) =>
                setDelimitedTextLatitudeField(event.target.value)
              }
            >
              {delimitedTextFieldOptions.map((field) => (
                <option key={field} value={field}>
                  {field}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </div>
    </AddDataSourceForm>
  );
}
