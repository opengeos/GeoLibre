import {
  createLayerSliceSelector,
  resolveLayerCapabilities,
  useAppCapability,
  useAppStore,
  useLayerSlices,
} from "@geolibre/core";
import { Input, Label, Select, Textarea } from "@geolibre/ui";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OgcProcess } from "../../lib/ogc-api-processes";
import {
  ogcInputKind,
  ogcInputSchema,
  ogcInputText,
  isRepeatedInput,
  serializeOgcProcessLayerInput,
} from "../../lib/ogc-process-inputs";

/** Schema-driven literals and JSON fields, with explicit layer-to-input insertion. */
export function OgcProcessInputs({
  process,
  values,
  onChange,
  disabled,
  error,
}: {
  process: OgcProcess;
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  disabled: boolean;
  error?: { name: string; id: string };
}) {
  const { t } = useTranslation();
  const prefix = useId();
  const [inputProblem, setInputProblem] = useState<{
    key: string;
    code: "inputLimit" | "inputOccurrences";
    parameters?: { name: string; count: number; minimum: number; maximum: number | string };
  } | null>(null);
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
    setInputProblem(null);
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
      {inputProblem !== null && (
        <p id={`${prefix}-limit`} role="alert" className="text-sm text-destructive">
          {t(`processing.ogcProcesses.errors.${inputProblem.code}`, inputProblem.parameters ?? {})}
        </p>
      )}
      {Object.entries(process.inputs).map(([key, definition]) => {
        const schema = ogcInputSchema(definition),
          kind = ogcInputKind(definition);
        const types =
          typeof schema.type === "string"
            ? [schema.type]
            : Array.isArray(schema.type)
              ? schema.type
              : undefined;
        const acceptsObject = !types || types.includes("object");
        const acceptsArray = !types || types.includes("array");
        const repeated = isRepeatedInput(definition);
        const collectionAllowed = acceptsObject;
        const arraysAllowed = repeated ? acceptsObject || acceptsArray : acceptsArray;
        const id = `${prefix}-${encodeURIComponent(key)}`;
        const fieldValue = Object.hasOwn(values, key) ? values[key] : "";
        const title = typeof definition.title === "string" ? definition.title : key;
        const enumeration = kind !== "json" && Array.isArray(schema.enum) ? schema.enum : undefined;
        const selected = enumeration?.find(
          (item) => Object.hasOwn(values, key) && ogcInputText(item, kind) === values[key],
        );
        const errorId =
          inputProblem?.key === key
            ? `${prefix}-limit`
            : error?.name === key
              ? error.id
              : undefined;
        const invalid = {
          "aria-invalid": errorId ? (true as const) : undefined,
          "aria-describedby": errorId,
        };
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
                {...invalid}
                aria-required={definition.minOccurs !== 0}
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
                {...invalid}
                aria-required={definition.minOccurs !== 0}
                disabled={disabled}
                value={fieldValue}
                onChange={(event) => set(key, event.target.value || undefined)}
              >
                <option value="">{t("processing.ogcProcesses.notSet")}</option>
                <option value="true">{t("processing.ogcProcesses.true")}</option>
                <option value="false">{t("processing.ogcProcesses.false")}</option>
              </Select>
            ) : kind === "json" ? (
              <Textarea
                id={id}
                {...invalid}
                aria-required={definition.minOccurs !== 0}
                disabled={disabled}
                value={fieldValue}
                className="min-h-24 font-mono text-xs"
                onChange={(event) => set(key, event.target.value)}
              />
            ) : (
              <Input
                id={id}
                {...invalid}
                aria-required={definition.minOccurs !== 0}
                disabled={disabled}
                value={fieldValue}
                type={kind === "string" ? "text" : "number"}
                step={kind === "integer" ? 1 : "any"}
                min={typeof schema.minimum === "number" ? schema.minimum : undefined}
                max={typeof schema.maximum === "number" ? schema.maximum : undefined}
                onChange={(event) =>
                  set(
                    key,
                    kind === "string" && definition.minOccurs === 0 && event.target.value === ""
                      ? undefined
                      : event.target.value,
                  )
                }
              />
            )}
            {kind === "json" && layers.length > 0 && (collectionAllowed || arraysAllowed) && (
              <Select
                {...invalid}
                aria-label={t("processing.ogcProcesses.layerInput", { name: title })}
                disabled={disabled || !exporting.granted}
                value=""
                onChange={(event) => {
                  if (!event.target.value || !exporting.granted) return;
                  const [layerId, representation] = JSON.parse(event.target.value) as [
                    string,
                    string,
                  ];
                  if (
                    !["collection", "features", "geometries"].includes(representation) ||
                    (representation === "collection" ? !collectionAllowed : !arraysAllowed)
                  )
                    return;
                  const layer = useAppStore.getState().layers.find((item) => item.id === layerId);
                  if (!layer?.geojson || !resolveLayerCapabilities(layer).export) return;
                  const value =
                    representation === "features"
                      ? layer.geojson.features
                      : representation === "geometries"
                        ? layer.geojson.features.map((feature) => feature.geometry)
                        : layer.geojson;
                  const qualify = (value: unknown) => ({
                    value,
                    mediaType: "application/geo+json",
                  });
                  const input =
                    representation === "collection"
                      ? repeated
                        ? [qualify(value)]
                        : qualify(value)
                      : repeated && Array.isArray(value)
                        ? acceptsObject
                          ? value.map(qualify)
                          : [value]
                        : value;
                  if (repeated && Array.isArray(input)) {
                    const minimum =
                      typeof definition.minOccurs === "number" ? definition.minOccurs : 1;
                    const maximum =
                      typeof definition.maxOccurs === "number" ? definition.maxOccurs : Infinity;
                    if (input.length < minimum || input.length > maximum) {
                      setInputProblem({
                        key,
                        code: "inputOccurrences",
                        parameters: {
                          name: title,
                          count: input.length,
                          minimum,
                          maximum: Number.isFinite(maximum) ? maximum : "∞",
                        },
                      });
                      return;
                    }
                  }
                  const serialized = serializeOgcProcessLayerInput(input);
                  if (serialized === null) {
                    setInputProblem({ key, code: "inputLimit" });
                    return;
                  }
                  set(key, serialized);
                }}
              >
                <option value="">{t("processing.ogcProcesses.insertLayer")}</option>
                {layers.map((layer) => (
                  <optgroup key={layer.id} label={layer.name}>
                    {collectionAllowed && (
                      <option value={JSON.stringify([layer.id, "collection"])}>
                        {t("processing.ogcProcesses.featureCollection")}
                      </option>
                    )}
                    {arraysAllowed && (
                      <option value={JSON.stringify([layer.id, "features"])}>
                        {t("processing.ogcProcesses.features")}
                      </option>
                    )}
                    {arraysAllowed && (
                      <option value={JSON.stringify([layer.id, "geometries"])}>
                        {t("processing.ogcProcesses.geometries")}
                      </option>
                    )}
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
