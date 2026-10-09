import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  applyObjectFeatures,
  type ObiaFeatureTable,
  type ObiaSampleRole,
} from "@geolibre/processing";
import { Button, Label, Select } from "@geolibre/ui";
import { FileUp, Import, Loader2 } from "lucide-react";
import { useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { openLocalDataFileWithFallback } from "../../../lib/file-io/file-dialogs";
import { obiaErrorMessage } from "../../../lib/obia/obia-errors";
import {
  ObiaImportError,
  labelFromSamples,
  parseClassSchema,
  parseFeatureTable,
  parseLevelMapping,
  rasterizeObjects,
  withClasses,
} from "../../../lib/obia/obia-import";
import { addBuiltLevel, buildCoarserLevel } from "../../../lib/obia/obia-levels";
import {
  ensureObiaLabels,
  obiaLayerLocation,
  obiaRunEnv,
} from "../../../lib/obia/obia-persistence";
import { useObiaSession } from "../../../lib/obia/obia-session";
import { ObiaStatus } from "./ObiaFields";
import { labelStylePatch } from "./ObiaTrainStep";

/** Geometry types a layer's features have. */
function geometryKinds(layer: GeoLibreLayer): Set<string> {
  return new Set((layer.geojson?.features ?? []).map((f) => f.geometry?.type ?? ""));
}

/** Property names of a layer's first features. */
function fieldsOf(layer: GeoLibreLayer | undefined): string[] {
  const names = new Set<string>();
  for (const feature of layer?.geojson?.features.slice(0, 50) ?? []) {
    for (const key of Object.keys(feature.properties ?? {})) names.add(key);
  }
  return [...names];
}

const readText = async (accept: string, extensions: string[]) => {
  const file = await openLocalDataFileWithFallback({
    accept,
    filters: [{ name: extensions.join(", ").toUpperCase(), extensions }],
    readText: true,
  });
  return file?.text ?? null;
};

/**
 * Import from other software (an eCognition export, for instance): objects
 * (polygons burned onto the image grid as a segmentation), training samples,
 * a class schema, a feature table, and a level mapping.
 */
export function ObiaImportPanel(): ReactElement {
  const { t } = useTranslation();
  const layers = useAppStore((s) => s.layers);
  const updateLayer = useAppStore((s) => s.updateLayer);
  const sourceLayerId = useObiaSession((s) => s.sourceLayerId);
  const bandIndexes = useObiaSession((s) => s.bandIndexes);
  const segmentation = useObiaSession((s) => s.segmentation);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const vectorLayers = useMemo(
    () => layers.filter((layer) => layer.geojson && layer.metadata.obiaRole !== "objects"),
    [layers],
  );
  const polygonLayers = vectorLayers.filter((layer) =>
    [...geometryKinds(layer)].some((kind) => kind.endsWith("Polygon")),
  );
  const [objectsFrom, setObjectsFrom] = useState("");
  const [idField, setIdField] = useState("");
  const [samplesFrom, setSamplesFrom] = useState("");
  const [classField, setClassField] = useState("");
  const [roleField, setRoleField] = useState("");
  const [role, setRole] = useState<ObiaSampleRole>("training");
  const objectsLayer = polygonLayers.find((layer) => layer.id === objectsFrom);
  const samplesLayer = vectorLayers.find((layer) => layer.id === samplesFrom);

  const run = async (key: string, task: () => Promise<string>) => {
    setBusy(key);
    setError(null);
    setResult(null);
    try {
      setResult(await task());
    } catch (err) {
      setError(
        err instanceof ObiaImportError
          ? t(`obia.import.error.${err.code}`)
          : obiaErrorMessage(err, t, t("obia.import.error.failed")),
      );
    } finally {
      setBusy(null);
    }
  };

  const importObjects = () =>
    run("objects", async () => {
      const source = layers.find((layer) => layer.id === sourceLayerId);
      if (!source) throw new Error(t("obia.import.error.noImage"));
      if (!objectsLayer?.geojson) throw new Error(t("obia.import.error.noLayer"));
      const imported = await rasterizeObjects(
        objectsLayer.geojson,
        source,
        bandIndexes,
        idField || null,
      );
      const store = useAppStore.getState();
      const id = store.addGeoJsonLayer(
        t("obia.layerName", { name: source.name }),
        imported.objects,
      );
      const added = useAppStore.getState().layers.find((layer) => layer.id === id);
      if (added) {
        store.updateLayer(id, {
          style: { ...added.style, fillOpacity: 0, strokeColor: "#facc15", strokeWidth: 1 },
          metadata: { ...added.metadata, obiaRole: "objects" },
        });
      }
      const location = obiaLayerLocation(source);
      useObiaSession.getState().setSegmentation({
        sourceLayerId: source.id,
        sourceName: source.name,
        source: { name: source.name, ...(location ? { location } : {}) },
        bandIndexes: [...bandIndexes],
        width: imported.width,
        height: imported.height,
        area: imported.area,
        pixelSize: imported.pixelSize,
        labels: imported.labels,
        objectsLayerId: id,
        objectCount: imported.objectCount,
        labelsHash: imported.labelsHash,
        meanObjectArea: imported.objectCount
          ? (imported.width * imported.height) / imported.objectCount
          : 0,
        tool: "obia/import-objects",
        args: [JSON.stringify({ layer: objectsLayer.name, idField: idField || null })],
        params: { ...useObiaSession.getState().params },
        imported: true,
        env: obiaRunEnv(),
        finishedAt: new Date().toISOString(),
      });
      return t("obia.import.objectsDone", {
        count: imported.objectCount,
        skipped: imported.skipped,
      });
    });

  const importSamples = () =>
    run("samples", async () => {
      const state = useObiaSession.getState();
      const current = state.segmentation;
      const source = layers.find((layer) => layer.id === current?.sourceLayerId);
      const objects = layers.find((layer) => layer.id === current?.objectsLayerId);
      if (!current || !source || !objects?.geojson)
        throw new Error(t("obia.import.error.noObjects"));
      if (!samplesLayer?.geojson || !classField) throw new Error(t("obia.import.error.noLayer"));
      const labels = await ensureObiaLabels();
      const labeled = await labelFromSamples(
        samplesLayer.geojson,
        classField,
        roleField || null,
        role,
        objects.geojson,
        labels,
        source,
        current.area,
      );
      const classes = withClasses(state.classes, labeled.classNames);
      state.setClasses(classes);
      updateLayer(objects.id, {
        geojson: labeled.objects,
        style: labelStylePatch(objects, classes),
      });
      return t("obia.import.samplesDone", { count: labeled.matched, missed: labeled.missed });
    });

  const importClasses = () =>
    run("classes", async () => {
      const text = await readText(".json,.csv", ["json", "csv"]);
      if (text == null) return "";
      const imported = parseClassSchema(text);
      const state = useObiaSession.getState();
      // Imported colors win for classes the workbench already has; new ones
      // follow in the file's order.
      state.setClasses([
        ...state.classes.map((item) => imported.find((other) => other.name === item.name) ?? item),
        ...imported.filter((item) => !state.classes.some((other) => other.name === item.name)),
      ]);
      return t("obia.import.classesDone", { count: imported.length });
    });

  const importFeatures = () =>
    run("features", async () => {
      const text = await readText(".csv", ["csv"]);
      if (text == null) return "";
      const imported = parseFeatureTable(text);
      const state = useObiaSession.getState();
      const current = state.segmentation;
      const objects = layers.find((layer) => layer.id === current?.objectsLayerId);
      if (!current || !objects?.geojson) throw new Error(t("obia.import.error.noObjects"));
      const before = state.features?.table;
      // Imported columns join the measured ones (and replace any of the same name).
      const fields = [
        ...(before?.fields ?? []).filter((field) => !imported.fields.includes(field)),
        ...imported.fields,
      ];
      const table: ObiaFeatureTable = { fields, rows: new Map() };
      for (const id of new Set([...(before?.rows.keys() ?? []), ...imported.rows.keys()])) {
        table.rows.set(id, { ...before?.rows.get(id), ...imported.rows.get(id) });
      }
      updateLayer(objects.id, {
        geojson: applyObjectFeatures(objects.geojson, table, before?.fields ?? []),
      });
      const call = {
        tool: "obia/import-features",
        args: [JSON.stringify({ fields: imported.fields })],
      };
      if (state.features) state.extendFeatures(table, call);
      else {
        state.setFeatures({
          segmentationAt: current.finishedAt,
          table,
          options: { spectral: false, shape: false, context: false },
          calls: [call],
          env: obiaRunEnv(),
          finishedAt: new Date().toISOString(),
        });
      }
      return t("obia.import.featuresDone", {
        count: imported.fields.length,
        objects: imported.rows.size,
      });
    });

  const importMapping = () =>
    run("mapping", async () => {
      const text = await readText(".csv", ["csv"]);
      if (text == null) return "";
      const mapping = parseLevelMapping(text);
      const current = useObiaSession.getState().segmentation;
      if (!current) throw new Error(t("obia.import.error.noObjects"));
      const built = await buildCoarserLevel(0, {}, mapping);
      addBuiltLevel(
        built,
        t("obia.levels.layerName", { name: current.source.name, level: built.record.level }),
      );
      return t("obia.import.mappingDone", {
        level: built.record.level,
        count: built.record.segmentation.objectCount,
      });
    });

  const button = (key: string, label: string, onClick: () => void, disabled = false) => (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="gap-1"
      disabled={busy !== null || disabled}
      onClick={onClick}
      data-testid={`obia-import-${key}`}
    >
      {busy === key ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : key === "objects" || key === "samples" ? (
        <Import className="h-3.5 w-3.5" />
      ) : (
        <FileUp className="h-3.5 w-3.5" />
      )}
      {label}
    </Button>
  );
  const fieldSelect = (
    id: string,
    label: string,
    value: string,
    onChange: (value: string) => void,
    fields: string[],
    empty: string,
  ) => (
    <div className="grid gap-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{empty}</option>
        {fields.map((field) => (
          <option key={field} value={field}>
            {field}
          </option>
        ))}
      </Select>
    </div>
  );

  return (
    <details className="border-t pt-3" data-testid="obia-import">
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t("obia.import.title")}
      </summary>
      <div className="mt-2 grid gap-3">
        <p className="text-xs text-muted-foreground">{t("obia.import.hint")}</p>

        <div className="grid gap-1.5">
          <span className="text-xs font-medium">{t("obia.import.objects")}</span>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1">
              <Label htmlFor="obia-import-objects-layer" className="text-xs">
                {t("obia.import.layer")}
              </Label>
              <Select
                id="obia-import-objects-layer"
                value={objectsFrom}
                onChange={(event) => setObjectsFrom(event.target.value)}
              >
                <option value="">{t("obia.import.chooseLayer")}</option>
                {polygonLayers.map((layer) => (
                  <option key={layer.id} value={layer.id}>
                    {layer.name}
                  </option>
                ))}
              </Select>
            </div>
            {fieldSelect(
              "obia-import-id-field",
              t("obia.import.idField"),
              idField,
              setIdField,
              fieldsOf(objectsLayer),
              t("obia.import.numberInOrder"),
            )}
          </div>
          <div>
            {button(
              "objects",
              t("obia.import.importObjects"),
              () => void importObjects(),
              !objectsLayer || !sourceLayerId,
            )}
          </div>
        </div>

        <div className="grid gap-1.5">
          <span className="text-xs font-medium">{t("obia.import.samples")}</span>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1">
              <Label htmlFor="obia-import-samples-layer" className="text-xs">
                {t("obia.import.layer")}
              </Label>
              <Select
                id="obia-import-samples-layer"
                value={samplesFrom}
                onChange={(event) => setSamplesFrom(event.target.value)}
              >
                <option value="">{t("obia.import.chooseLayer")}</option>
                {vectorLayers.map((layer) => (
                  <option key={layer.id} value={layer.id}>
                    {layer.name}
                  </option>
                ))}
              </Select>
            </div>
            {fieldSelect(
              "obia-import-class-field",
              t("obia.import.classField"),
              classField,
              setClassField,
              fieldsOf(samplesLayer),
              t("obia.import.chooseField"),
            )}
            {fieldSelect(
              "obia-import-role-field",
              t("obia.import.roleField"),
              roleField,
              setRoleField,
              fieldsOf(samplesLayer),
              t("obia.import.noRoleField"),
            )}
            <div className="grid gap-1">
              <Label htmlFor="obia-import-role" className="text-xs">
                {t("obia.import.role")}
              </Label>
              <Select
                id="obia-import-role"
                value={role}
                onChange={(event) =>
                  setRole(event.target.value === "validation" ? "validation" : "training")
                }
              >
                <option value="training">{t("obia.train.roles.training")}</option>
                <option value="validation">{t("obia.train.roles.validation")}</option>
              </Select>
            </div>
          </div>
          <div>
            {button(
              "samples",
              t("obia.import.importSamples"),
              () => void importSamples(),
              !segmentation || !samplesLayer || !classField,
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {button("classes", t("obia.import.classSchema"), () => void importClasses())}
          {button(
            "features",
            t("obia.import.featureTable"),
            () => void importFeatures(),
            !segmentation,
          )}
          {button(
            "mapping",
            t("obia.import.levelMapping"),
            () => void importMapping(),
            !segmentation,
          )}
        </div>
        <ObiaStatus error={error} success={result || null} testId="obia-import-result" />
      </div>
    </details>
  );
}
