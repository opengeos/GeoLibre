import {
  createLayerSliceSelector,
  resolveLayerCapabilities,
  useAppCapability,
  useAppStore,
  useLayerSlices,
} from "@geolibre/core";
import { Input, Label, Select, Textarea } from "@geolibre/ui";
import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { OgcProcess } from "../../lib/ogc-api-processes";
import { ogcInputKind, ogcInputSchema, ogcInputText } from "../../lib/ogc-process-inputs";

/** Schema-driven literals and JSON fields, with explicit layer-to-input insertion. */
export function OgcProcessInputs({
  process,
  values,
  onChange,
  disabled,
}: {
  process: OgcProcess;
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const prefix = useId();
  const exporting = useAppCapability("export:data");
  const layers = useLayerSlices(
    useMemo(
      () =>
        createLayerSliceSelector((layer) =>
          layer.type === "geojson" && layer.geojson && resolveLayerCapabilities(layer).export
            ? { id: layer.id, name: layer.name }
            : null,
        ),
      [],
    ),
  );
  const set = (key: string, value: string | undefined) => {
    const next = { ...values };
    if (value === undefined) delete next[key];
    else
      Object.defineProperty(next, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    onChange(next);
  };
  return (
    <div className="space-y-4">
      {Object.entries(process.inputs).map(([key, definition]) => {
        const schema = ogcInputSchema(definition),
          kind = ogcInputKind(definition);
        const id = `${prefix}-${encodeURIComponent(key)}`;
        const title = typeof definition.title === "string" ? definition.title : key;
        const enumeration = kind !== "json" && Array.isArray(schema.enum) ? schema.enum : undefined;
        const selected = enumeration?.find(
          (item) => Object.hasOwn(values, key) && ogcInputText(item, kind) === values[key],
        );
        return (
          <div key={key} className="space-y-1.5">
            <Label htmlFor={id}>
              {title}
              {definition.minOccurs !== 0 ? " *" : ""}
            </Label>
            {typeof definition.description === "string" && (
              <p className="text-xs text-muted-foreground">{definition.description}</p>
            )}
            {enumeration ? (
              <Select
                id={id}
                disabled={disabled}
                value={selected === undefined ? "" : JSON.stringify(selected)}
                onChange={(event) =>
                  set(
                    key,
                    event.target.value
                      ? ogcInputText(JSON.parse(event.target.value), kind)
                      : undefined,
                  )
                }
              >
                <option value="">{t("processing.ogcProcesses.notSet")}</option>
                {enumeration.map((item, index) => (
                  <option key={index} value={JSON.stringify(item)}>
                    {typeof item === "string" ? item : JSON.stringify(item)}
                  </option>
                ))}
              </Select>
            ) : kind === "boolean" ? (
              <Select
                id={id}
                disabled={disabled}
                value={values[key] ?? ""}
                onChange={(event) => set(key, event.target.value || undefined)}
              >
                <option value="">{t("processing.ogcProcesses.notSet")}</option>
                <option value="true">{t("processing.ogcProcesses.true")}</option>
                <option value="false">{t("processing.ogcProcesses.false")}</option>
              </Select>
            ) : kind === "json" ? (
              <Textarea
                id={id}
                disabled={disabled}
                value={values[key] ?? ""}
                className="min-h-24 font-mono text-xs"
                onChange={(event) => set(key, event.target.value)}
              />
            ) : (
              <Input
                id={id}
                disabled={disabled}
                value={values[key] ?? ""}
                type={kind === "string" ? "text" : "number"}
                step={kind === "integer" ? 1 : "any"}
                min={typeof schema.minimum === "number" ? schema.minimum : undefined}
                max={typeof schema.maximum === "number" ? schema.maximum : undefined}
                onChange={(event) =>
                  set(
                    key,
                    kind === "string" && event.target.value === "" ? undefined : event.target.value,
                  )
                }
              />
            )}
            {kind === "json" && layers.length > 0 && (
              <Select
                aria-label={t("processing.ogcProcesses.layerInput", { name: title })}
                disabled={disabled || !exporting.granted}
                value=""
                onChange={(event) => {
                  if (!event.target.value || !exporting.granted) return;
                  const [id, representation] = JSON.parse(event.target.value) as [string, string];
                  const layer = useAppStore.getState().layers.find((item) => item.id === id);
                  if (!layer?.geojson || !resolveLayerCapabilities(layer).export) return;
                  const value =
                    representation === "features"
                      ? layer.geojson.features
                      : representation === "geometries"
                        ? layer.geojson.features.map((feature) => feature.geometry)
                        : layer.geojson;
                  set(
                    key,
                    JSON.stringify(
                      representation === "collection"
                        ? { value, mediaType: "application/geo+json" }
                        : value,
                    ),
                  );
                }}
              >
                <option value="">{t("processing.ogcProcesses.insertLayer")}</option>
                {layers.map((layer) => (
                  <optgroup key={layer.id} label={layer.name}>
                    <option value={JSON.stringify([layer.id, "collection"])}>
                      {t("processing.ogcProcesses.featureCollection")}
                    </option>
                    <option value={JSON.stringify([layer.id, "features"])}>
                      {t("processing.ogcProcesses.features")}
                    </option>
                    <option value={JSON.stringify([layer.id, "geometries"])}>
                      {t("processing.ogcProcesses.geometries")}
                    </option>
                  </optgroup>
                ))}
              </Select>
            )}
            <details className="text-xs text-muted-foreground">
              <summary>{t("processing.ogcProcesses.schema")}</summary>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">
                {JSON.stringify(definition.schema ?? {}, null, 2)}
              </pre>
            </details>
          </div>
        );
      })}
    </div>
  );
}
