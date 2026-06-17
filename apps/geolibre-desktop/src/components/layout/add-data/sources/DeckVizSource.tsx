import {
  createDeckVizStoreLayer,
  DECK_VIZ_CATEGORY_LABELS,
  DEFAULT_DECK_VIZ_SCENEGRAPH,
  DEFAULT_DECK_VIZ_STYLE,
  ensureMercatorProjection,
  getDeckVizLayerDef,
  listDeckVizLayerDefs,
  type DeckVizCategory,
  type DeckVizFieldMapping,
  type DeckVizScenegraphConfig,
  type DeckVizStyle,
} from "@geolibre/plugins";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { Columns3, FileUp, Globe2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  autoDetectFieldMapping,
  computeDeckVizBounds,
  type DeckVizParsedInput,
  detectAndParseDeckVizInput,
} from "../../../../lib/deck-viz-input";
import { openLocalDataFileWithFallback } from "../../../../lib/tauri-io";
import { DECK_VIZ_SIZE_WARN_BYTES } from "../constants";
import { errorMessage, geoJsonToPointRows } from "../helpers";
import { AddDataSourceForm, useAddDataSource } from "../shared";

interface DeckVizSourceProps {
  /**
   * Deck.gl layer kind to pre-select (e.g. a "3D model" menu entry opens the
   * dialog on the scenegraph layer type).
   */
  initialDeckVizKind?: string;
}

export function DeckVizSource({ initialDeckVizKind }: DeckVizSourceProps) {
  const { t } = useTranslation();
  const startKind = initialDeckVizKind || "scatterplot";
  const startExample = getDeckVizLayerDef(startKind)?.example;
  const startSg = startExample?.scenegraph;
  const [startLng, startLat] = startExample?.scenegraphLocation ?? ["", ""];

  const source = useAddDataSource(
    getDeckVizLayerDef(startKind)?.label ?? t("addData.deckViz.defaultName"),
  );

  const [deckVizKind, setDeckVizKind] = useState(startKind);
  const [deckVizMode, setDeckVizMode] = useState<"url" | "file">("url");
  const [deckVizUrl, setDeckVizUrl] = useState("");
  const [deckVizSourcePath, setDeckVizSourcePath] = useState("");
  const [deckVizParsed, setDeckVizParsed] = useState<DeckVizParsedInput | null>(
    null,
  );
  const [deckVizMapping, setDeckVizMapping] = useState<DeckVizFieldMapping>({});
  const [deckVizStyle, setDeckVizStyle] = useState<DeckVizStyle>({
    ...DEFAULT_DECK_VIZ_STYLE,
  });
  const [deckVizStatus, setDeckVizStatus] = useState<string | null>(null);
  const [isLoadingDeckViz, setIsLoadingDeckViz] = useState(false);
  // Scenegraph (glTF 3D model) layer-specific inputs.
  const [deckVizModelUrl, setDeckVizModelUrl] = useState(startSg?.modelUrl ?? "");
  const [deckVizModelMode, setDeckVizModelMode] = useState<"single" | "data">(
    "single",
  );
  const [deckVizModelScale, setDeckVizModelScale] = useState(
    String(startSg?.sizeScale ?? DEFAULT_DECK_VIZ_SCENEGRAPH.sizeScale),
  );
  const [deckVizModelBearing, setDeckVizModelBearing] = useState(
    String(startSg?.bearing ?? 0),
  );
  const [deckVizModelAltitude, setDeckVizModelAltitude] = useState(
    String(startSg?.altitude ?? 0),
  );
  const [deckVizModelLng, setDeckVizModelLng] = useState(String(startLng));
  const [deckVizModelLat, setDeckVizModelLat] = useState(String(startLat));

  // The deck.gl overlay only aligns in a Mercator viewport, so switch away from
  // globe as soon as the Deck.gl Layer dialog opens.
  useEffect(() => {
    ensureMercatorProjection(source.shell.mapControllerRef.current?.getMap());
    // Mount-only: switch the projection once when the dialog opens.
    // `mapControllerRef` is a stable ref and must not be a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const deckVizDef = getDeckVizLayerDef(deckVizKind);
  const isScenegraphKind = deckVizKind === "scenegraph";
  // Single-location scenegraph mode types a coordinate instead of loading a
  // point file, so the data-loader UI is hidden then.
  const showDeckVizDataLoader = !(
    isScenegraphKind && deckVizModelMode === "single"
  );

  const handleDeckVizKindChange = (nextKind: string) => {
    setDeckVizKind(nextKind);
    setDeckVizParsed(null);
    setDeckVizMapping({});
    setDeckVizStatus(null);
    source.setError(null);
    setDeckVizStyle({ ...DEFAULT_DECK_VIZ_STYLE });
    const nextDef = getDeckVizLayerDef(nextKind);
    source.setLayerName(nextDef?.label ?? t("addData.deckViz.defaultName"));
    // Pre-fill the scenegraph model URL and transform from the bundled example
    // so the user can place a model immediately (and tweak from there).
    const exampleSg = nextDef?.example.scenegraph;
    if (nextKind === "scenegraph" && exampleSg) {
      setDeckVizModelUrl(exampleSg.modelUrl);
      setDeckVizModelScale(String(exampleSg.sizeScale));
      setDeckVizModelBearing(String(exampleSg.bearing));
      setDeckVizModelAltitude(String(exampleSg.altitude));
      // Reset placement back to single-location: the data-mode parse was
      // cleared above, so leaving mode on "data" would strand the submit
      // button disabled with no point file loaded.
      setDeckVizModelMode("single");
      const [lng, lat] = nextDef?.example.scenegraphLocation ?? ["", ""];
      setDeckVizModelLng(String(lng));
      setDeckVizModelLat(String(lat));
    }
  };

  // Builds the scenegraph config from the dialog inputs, falling back to the
  // defaults for any field the user left blank/invalid.
  const buildScenegraphConfig = (): DeckVizScenegraphConfig => {
    const numOr = (value: string, fallback: number): number => {
      // Number("") is 0 (and finite), so treat a blank field as unset and use
      // the fallback rather than silently zeroing scale/bearing/altitude.
      if (value.trim() === "") return fallback;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    return {
      modelUrl: deckVizModelUrl.trim(),
      sizeScale: numOr(deckVizModelScale, DEFAULT_DECK_VIZ_SCENEGRAPH.sizeScale),
      bearing: numOr(deckVizModelBearing, 0),
      altitude: numOr(deckVizModelAltitude, 0),
    };
  };

  const readDeckVizSource = async (): Promise<{
    sourcePath: string;
    text: string;
  }> => {
    let result: { sourcePath: string; text: string };
    if (deckVizMode === "file") {
      const selected = await openLocalDataFileWithFallback({
        filters: [
          {
            name: "Data",
            extensions: ["csv", "tsv", "txt", "json", "geojson"],
          },
        ],
        accept: ".csv,.tsv,.txt,.json,.geojson",
        readText: true,
      });
      if (!selected?.text) {
        throw new Error(t("addData.deckViz.errorChooseFile"));
      }
      result = { sourcePath: selected.path, text: selected.text };
    } else {
      const sourcePath = deckVizUrl.trim();
      if (!sourcePath) throw new Error(t("addData.deckViz.errorUrl"));
      const response = await fetch(sourcePath);
      if (!response.ok) {
        throw new Error(t("addData.common.requestFailed", { status: response.status }));
      }
      result = { sourcePath, text: await response.text() };
    }
    if (result.text.length > DECK_VIZ_SIZE_WARN_BYTES) {
      console.warn(
        "[GeoLibre] deck-viz: large payload stored inline in the project",
        result.text.length,
        "bytes",
      );
    }
    return result;
  };

  // Validates format/role completeness, then writes the deck-viz store layer
  // and fits the map. Shared by the "Use example data" and submit paths.
  const finalizeDeckVizLayer = (params: {
    parsed: DeckVizParsedInput;
    mapping: DeckVizFieldMapping;
    style: DeckVizStyle;
    sourcePath: string;
    scenegraph?: DeckVizScenegraphConfig;
  }) => {
    const def = getDeckVizLayerDef(deckVizKind);
    if (!def) throw new Error(t("addData.deckViz.errorUnknownType"));
    // The model URL is already enforced by the submit handler and the disabled
    // state of the Add button, and the example path always supplies one, so no
    // redundant guard is needed here.
    const { style, sourcePath, scenegraph } = params;
    let { parsed, mapping } = params;

    // The 3D-model layer renders from row data; a dropped GeoJSON point
    // collection is converted to rows so GeoJSON point files work alongside
    // CSV/JSON (the shared file picker offers .geojson).
    if (def.kind === "scenegraph" && parsed.format === "geojson") {
      const rows = geoJsonToPointRows(parsed.geojson);
      if (rows.length === 0) {
        throw new Error(t("toolbar.error.scenegraphNoPointFeatures"));
      }
      parsed = {
        format: "csv-rows",
        columns: Object.keys(rows[0]).map((key) => ({ value: key, label: key })),
        rows,
        rowCount: rows.length,
      };
      // lon/lat come from geometry; keep any property-mapped roles intact.
      mapping = { ...mapping, lng: "lng", lat: "lat" };
    }

    if (def.format === "geojson" && parsed.format !== "geojson") {
      throw new Error(t("addData.deckViz.needsGeojson", { label: def.label }));
    }
    if (def.format !== "geojson" && parsed.format === "geojson") {
      throw new Error(t("addData.deckViz.needsTabular", { label: def.label }));
    }
    const missing = def.roles.filter(
      (role) =>
        role.required &&
        (mapping[role.key] === undefined || mapping[role.key] === ""),
    );
    if (missing.length > 0) {
      throw new Error(
        t("addData.deckViz.mapRequiredFields", {
          count: missing.length,
          fields: missing.map((role) => role.label).join(", "),
        }),
      );
    }

    const bounds =
      parsed.format === "geojson"
        ? undefined
        : (computeDeckVizBounds(parsed.rows ?? [], mapping) ?? undefined);
    const layer = createDeckVizStoreLayer({
      name: source.layerName.trim() || def.label,
      config: {
        layerKind: def.kind,
        format: parsed.format,
        fieldMapping: mapping,
        style,
        ...(scenegraph ? { scenegraph } : {}),
      },
      rows: parsed.format === "geojson" ? undefined : parsed.rows,
      geojson: parsed.geojson,
      sourcePath,
      bounds,
    });
    source.shell.addLayer(layer, source.beforeLayer);
    // GeoJSON fits from its geometry; row-based layers fit from the stored
    // bounds (also used by the layer panel's "Zoom to layer").
    if (def.format === "geojson") {
      source.shell.mapControllerRef.current?.fitLayer(layer);
    } else if (bounds) {
      source.shell.mapControllerRef.current?.fitBounds(bounds);
    }
    source.shell.closeDialog();
  };

  const handleUseDeckVizExample = async () => {
    const def = getDeckVizLayerDef(deckVizKind);
    if (!def) return;
    source.setError(null);
    setDeckVizStatus(null);
    setIsLoadingDeckViz(true);
    try {
      const response = await fetch(def.example.url);
      if (!response.ok) {
        throw new Error(t("addData.common.requestFailed", { status: response.status }));
      }
      const parsed = detectAndParseDeckVizInput(await response.text());
      finalizeDeckVizLayer({
        parsed,
        mapping: def.example.fieldMapping,
        style: { ...DEFAULT_DECK_VIZ_STYLE, ...(def.example.style ?? {}) },
        sourcePath: def.example.url,
        scenegraph: def.example.scenegraph,
      });
    } catch (err) {
      source.setError(errorMessage(err, t("addData.deckViz.errorExample")));
    } finally {
      setIsLoadingDeckViz(false);
    }
  };

  const handleRetrieveDeckVizColumns = async () => {
    const def = getDeckVizLayerDef(deckVizKind);
    if (!def) return;
    source.setError(null);
    setDeckVizStatus(null);
    setIsLoadingDeckViz(true);
    try {
      const { sourcePath, text } = await readDeckVizSource();
      const parsed = detectAndParseDeckVizInput(text);
      if (def.format === "geojson" && parsed.format !== "geojson") {
        throw new Error(t("addData.deckViz.needsGeojson", { label: def.label }));
      }
      if (def.format !== "geojson" && parsed.format === "geojson") {
        throw new Error(t("addData.deckViz.needsTabular", { label: def.label }));
      }
      setDeckVizParsed(parsed);
      setDeckVizSourcePath(sourcePath);
      setDeckVizMapping(autoDetectFieldMapping(def.roles, parsed.columns));
      setDeckVizStatus(
        parsed.format === "geojson"
          ? t("addData.deckViz.loadedFeatures", { count: parsed.rowCount })
          : // `loadedTabular` interpolates {{rows}} and {{columns}} as already-
            // pluralized fragments ("3 rows", "2 columns") from loadedRows/
            // loadedColumns. Composing this way keeps each count on its own
            // i18next plural rules (correct for languages with >2 plural forms),
            // while loadedTabular still owns the "Loaded …", the separator, and
            // the trailing period so translators control order and punctuation.
            t("addData.deckViz.loadedTabular", {
              rows: t("addData.deckViz.loadedRows", { count: parsed.rowCount }),
              columns: t("addData.deckViz.loadedColumns", {
                count: parsed.columns.length,
              }),
            }),
      );
    } catch (err) {
      source.setError(errorMessage(err, t("addData.deckViz.errorLoad")));
      setDeckVizParsed(null);
    } finally {
      setIsLoadingDeckViz(false);
    }
  };

  const setDeckVizRole = (roleKey: string, value: string) => {
    setDeckVizMapping((current) => {
      const next = { ...current };
      if (value === "") {
        delete next[roleKey];
        return next;
      }
      // Numeric columns (JSON tuple arrays) are stored as indices.
      const numeric = Number(value);
      next[roleKey] =
        deckVizParsed?.format === "json-array" && Number.isFinite(numeric)
          ? numeric
          : value;
      return next;
    });
  };

  const handleSubmit = source.runSubmit(() => {
    const isScenegraph = deckVizKind === "scenegraph";
    const scenegraph = isScenegraph ? buildScenegraphConfig() : undefined;
    if (isScenegraph && !scenegraph?.modelUrl) {
      throw new Error(t("toolbar.error.scenegraphModelUrlRequired"));
    }
    // Single-location mode synthesizes a one-row dataset from the typed
    // coordinate instead of loading a point file.
    if (isScenegraph && deckVizModelMode === "single") {
      // Number("") is 0, so treat a blank field as missing rather than the
      // valid coordinate 0.
      const parseCoord = (value: string): number =>
        value.trim() === "" ? Number.NaN : Number(value);
      const lng = parseCoord(deckVizModelLng);
      const lat = parseCoord(deckVizModelLat);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        throw new Error(t("toolbar.error.scenegraphInvalidLngLat"));
      }
      if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
        throw new Error(t("toolbar.error.scenegraphOutOfRange"));
      }
      finalizeDeckVizLayer({
        parsed: {
          format: "csv-rows",
          columns: [
            { value: "lng", label: "lng" },
            { value: "lat", label: "lat" },
          ],
          rows: [{ lng, lat }],
          rowCount: 1,
        },
        mapping: { lng: "lng", lat: "lat" },
        style: deckVizStyle,
        sourcePath: scenegraph?.modelUrl ?? "",
        scenegraph,
      });
      return;
    }
    if (!deckVizParsed) {
      throw new Error(t("addData.deckViz.errorLoadFirst"));
    }
    finalizeDeckVizLayer({
      parsed: deckVizParsed,
      mapping: deckVizMapping,
      style: deckVizStyle,
      sourcePath: deckVizSourcePath,
      scenegraph,
    });
  });

  const submitDisabled =
    source.isSubmitting ||
    isLoadingDeckViz ||
    (isScenegraphKind && !deckVizModelUrl.trim()) ||
    (!deckVizParsed &&
      !(isScenegraphKind && deckVizModelMode === "single"));

  return (
    <AddDataSourceForm
      layerName={source.layerName}
      onLayerNameChange={source.setLayerName}
      beforeLayerId={source.beforeLayerId}
      onBeforeLayerIdChange={source.setBeforeLayerId}
      onSubmit={handleSubmit}
      error={source.error}
      submitDisabled={submitDisabled}
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="deckviz-kind">{t("addData.common.layerType")}</Label>
          <Select
            id="deckviz-kind"
            value={deckVizKind}
            disabled={isLoadingDeckViz}
            onChange={(event) => handleDeckVizKindChange(event.target.value)}
          >
            {(Object.keys(DECK_VIZ_CATEGORY_LABELS) as DeckVizCategory[]).map(
              (category) => (
                <optgroup
                  key={category}
                  label={DECK_VIZ_CATEGORY_LABELS[category]}
                >
                  {listDeckVizLayerDefs()
                    .filter((def) => def.category === category)
                    .map((def) => (
                      <option key={def.kind} value={def.kind}>
                        {def.label}
                      </option>
                    ))}
                </optgroup>
              ),
            )}
          </Select>
          {deckVizDef ? (
            <p className="text-xs text-muted-foreground">
              {deckVizDef.description}
            </p>
          ) : null}
        </div>

        {isScenegraphKind ? (
          <div className="space-y-3 rounded-md border border-border p-3">
            <div className="space-y-1.5">
              <Label htmlFor="deckviz-model-url">
                {t("toolbar.scenegraph.modelUrl")}
              </Label>
              <Input
                id="deckviz-model-url"
                placeholder={t("addData.deckViz.modelUrlPlaceholder")}
                value={deckVizModelUrl}
                onChange={(event) => setDeckVizModelUrl(event.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="deckviz-model-mode">
                {t("toolbar.scenegraph.placement")}
              </Label>
              <Select
                id="deckviz-model-mode"
                value={deckVizModelMode}
                onChange={(event) => {
                  setDeckVizModelMode(event.target.value as "single" | "data");
                  setDeckVizParsed(null);
                  setDeckVizStatus(null);
                }}
              >
                <option value="single">
                  {t("toolbar.scenegraph.placementSingle")}
                </option>
                <option value="data">
                  {t("toolbar.scenegraph.placementData")}
                </option>
              </Select>
            </div>

            {deckVizModelMode === "single" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="deckviz-model-lng">
                    {t("toolbar.scenegraph.longitude")}
                  </Label>
                  <Input
                    id="deckviz-model-lng"
                    inputMode="decimal"
                    placeholder="-122.45"
                    value={deckVizModelLng}
                    onChange={(event) => setDeckVizModelLng(event.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="deckviz-model-lat">
                    {t("toolbar.scenegraph.latitude")}
                  </Label>
                  <Input
                    id="deckviz-model-lat"
                    inputMode="decimal"
                    placeholder="37.78"
                    value={deckVizModelLat}
                    onChange={(event) => setDeckVizModelLat(event.target.value)}
                  />
                </div>
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="deckviz-model-scale">
                  {t("toolbar.scenegraph.scale")}
                </Label>
                <Input
                  id="deckviz-model-scale"
                  inputMode="numeric"
                  value={deckVizModelScale}
                  onChange={(event) => setDeckVizModelScale(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="deckviz-model-bearing">
                  {t("toolbar.scenegraph.bearing")}
                </Label>
                <Input
                  id="deckviz-model-bearing"
                  inputMode="numeric"
                  value={deckVizModelBearing}
                  onChange={(event) =>
                    setDeckVizModelBearing(event.target.value)
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="deckviz-model-altitude">
                  {t("toolbar.scenegraph.altitude")}
                </Label>
                <Input
                  id="deckviz-model-altitude"
                  inputMode="numeric"
                  value={deckVizModelAltitude}
                  onChange={(event) =>
                    setDeckVizModelAltitude(event.target.value)
                  }
                />
              </div>
            </div>
          </div>
        ) : null}

        {showDeckVizDataLoader ? (
          <>
            <Button
              type="button"
              variant="outline"
              onClick={handleUseDeckVizExample}
              disabled={isLoadingDeckViz}
            >
              <Globe2 className="mr-2 h-3.5 w-3.5" />
              {isLoadingDeckViz ? t("addData.common.loading") : t("addData.deckViz.useExample")}
            </Button>

            <div className="space-y-1.5">
              <Label htmlFor="deckviz-mode">{t("addData.deckViz.loadYourOwn")}</Label>
              <Select
                id="deckviz-mode"
                value={deckVizMode}
                disabled={isLoadingDeckViz}
                onChange={(event) => {
                  setDeckVizMode(event.target.value as "url" | "file");
                  setDeckVizParsed(null);
                  setDeckVizStatus(null);
                  setIsLoadingDeckViz(false);
                }}
              >
                <option value="url">{t("addData.deckViz.dataUrl")}</option>
                <option value="file">{t("addData.deckViz.localFile")}</option>
              </Select>
            </div>

            {deckVizMode === "url" ? (
              <div className="space-y-1.5">
                <Label htmlFor="deckviz-url">{t("addData.deckViz.dataUrl")}</Label>
                <Input
                  id="deckviz-url"
                  placeholder={t("addData.deckViz.urlPlaceholder")}
                  value={deckVizUrl}
                  onChange={(event) => {
                    setDeckVizUrl(event.target.value);
                    setDeckVizParsed(null);
                  }}
                />
              </div>
            ) : null}

            <Button
              type="button"
              variant="outline"
              onClick={handleRetrieveDeckVizColumns}
              disabled={
                isLoadingDeckViz || (deckVizMode === "url" && !deckVizUrl.trim())
              }
            >
              {deckVizMode === "file" ? (
                <FileUp className="mr-2 h-3.5 w-3.5" />
              ) : (
                <Columns3 className="mr-2 h-3.5 w-3.5" />
              )}
              {isLoadingDeckViz
                ? t("addData.common.loading")
                : deckVizMode === "file"
                  ? t("addData.deckViz.chooseFileLoad")
                  : t("addData.deckViz.loadData")}
            </Button>
            {deckVizStatus ? (
              <p className="text-xs text-muted-foreground">{deckVizStatus}</p>
            ) : null}

            {deckVizParsed && deckVizDef && deckVizDef.roles.length > 0 ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {deckVizDef.roles.map((role) => (
                  <div key={role.key} className="space-y-1.5">
                    <Label htmlFor={`deckviz-role-${role.key}`}>
                      {role.label}
                    </Label>
                    <Select
                      id={`deckviz-role-${role.key}`}
                      value={String(deckVizMapping[role.key] ?? "")}
                      onChange={(event) =>
                        setDeckVizRole(role.key, event.target.value)
                      }
                    >
                      <option value="">
                        {role.required ? t("addData.deckViz.selectRole") : t("addData.deckViz.roleNone")}
                      </option>
                      {deckVizParsed.columns.map((column) => (
                        <option
                          key={String(column.value)}
                          value={String(column.value)}
                        >
                          {column.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}

        {deckVizDef ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {deckVizDef.styleControls.includes("color") ? (
              <div className="space-y-1.5">
                <Label htmlFor="deckviz-color">{t("addData.deckViz.color")}</Label>
                <input
                  id="deckviz-color"
                  type="color"
                  className="h-9 w-full rounded-md border border-input bg-background"
                  value={deckVizStyle.color}
                  onChange={(event) =>
                    setDeckVizStyle((style) => ({
                      ...style,
                      color: event.target.value,
                    }))
                  }
                />
              </div>
            ) : null}
            {deckVizDef.styleControls.includes("radius") ? (
              <div className="space-y-1.5">
                <Label htmlFor="deckviz-radius">{t("addData.deckViz.pointSize")}</Label>
                <Input
                  id="deckviz-radius"
                  inputMode="numeric"
                  value={String(deckVizStyle.radius)}
                  onChange={(event) =>
                    setDeckVizStyle((style) => ({
                      ...style,
                      radius: Number.isFinite(Number(event.target.value))
                        ? Number(event.target.value)
                        : style.radius,
                    }))
                  }
                />
              </div>
            ) : null}
            {deckVizDef.styleControls.includes("cellSize") ? (
              <div className="space-y-1.5">
                <Label htmlFor="deckviz-cellsize">{t("addData.deckViz.cellSize")}</Label>
                <Input
                  id="deckviz-cellsize"
                  inputMode="numeric"
                  value={String(deckVizStyle.cellSize)}
                  onChange={(event) =>
                    setDeckVizStyle((style) => ({
                      ...style,
                      cellSize: Number.isFinite(Number(event.target.value))
                        ? Number(event.target.value)
                        : style.cellSize,
                    }))
                  }
                />
              </div>
            ) : null}
            {deckVizDef.styleControls.includes("lineWidth") ? (
              <div className="space-y-1.5">
                <Label htmlFor="deckviz-linewidth">{t("addData.deckViz.lineWidth")}</Label>
                <Input
                  id="deckviz-linewidth"
                  inputMode="numeric"
                  value={String(deckVizStyle.lineWidth)}
                  onChange={(event) =>
                    setDeckVizStyle((style) => ({
                      ...style,
                      lineWidth: Number.isFinite(Number(event.target.value))
                        ? Number(event.target.value)
                        : style.lineWidth,
                    }))
                  }
                />
              </div>
            ) : null}
            {deckVizDef.styleControls.includes("extruded") ? (
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={deckVizStyle.extruded}
                  onChange={(event) =>
                    setDeckVizStyle((style) => ({
                      ...style,
                      extruded: event.target.checked,
                    }))
                  }
                />
                {t("addData.deckViz.extrusion")}
              </label>
            ) : null}
          </div>
        ) : null}
      </div>
    </AddDataSourceForm>
  );
}
