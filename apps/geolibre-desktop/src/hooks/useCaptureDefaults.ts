import { currentEditorIdentity, type AttributeFormConfig } from "@geolibre/core";
import { useEffect, useRef, useState } from "react";
import {
  applyCaptureDefaults,
  captureExpressionVariables,
  defaultValueEpsgCodes,
  hasAttributeFormDefaults,
  loadDefaultValueTransform,
  type DefaultValueTransform,
} from "../lib/field-collection-defaults";
import {
  buildPropertiesWithForm,
  type CollectionSchema,
  type GeometryType,
  type Vertex,
} from "../lib/field-collection";
import type { GpsFix } from "../lib/gps-tracking";

interface CaptureDefaultsOptions {
  /** The captured location, or null before one exists. */
  pending: Vertex[] | null;
  /**
   * Changes when one capture ends and the next begins. A table's records
   * have no location to go null between captures, so this is what tells them
   * apart.
   */
  captureKey?: string;
  /** The GPS fix the location came from; null for a map pick. */
  gpsFix: GpsFix | null;
  schema: CollectionSchema | null;
  /** The capture target's form, narrowed to the schema's fields. */
  attributeForm: AttributeFormConfig | undefined;
  geometry: GeometryType;
  layerName: string | undefined;
  values: Record<string, string>;
  setValues: (values: Record<string, string>) => void;
}

/**
 * Pre-fills the Field Collection form from the layer's default-value
 * expressions (#3398): when a location is captured or moved, and again when
 * the user edits a field another default reads. Fields the user has typed
 * over are left alone. The rules live in `applyCaptureDefaults`.
 */
export function useCaptureDefaults({
  pending,
  captureKey = "",
  gpsFix,
  schema,
  attributeForm,
  geometry,
  layerName,
  values,
  setValues,
}: CaptureDefaultsOptions): void {
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const autoFilledRef = useRef<Record<string, string>>({});
  const [transform, setTransform] = useState<DefaultValueTransform | null>(null);

  // Keyed on the EPSG codes the form names, not on the form object: that is
  // rebuilt whenever the layer changes (after every save), and reloading then
  // would briefly empty the projected defaults of the next capture.
  const epsgKey = defaultValueEpsgCodes(attributeForm).join(",");
  const formRef = useRef(attributeForm);
  formRef.current = attributeForm;
  useEffect(() => {
    let cancelled = false;
    setTransform(null);
    loadDefaultValueTransform(formRef.current)
      .then((loaded) => {
        // Wrapped: a bare function passed to a state setter is called as an updater.
        if (!cancelled && loaded) setTransform(() => loaded);
      })
      .catch((error) => {
        // Projected defaults then stay empty rather than wrong.
        console.warn("[GeoLibre] Could not load projections for default values.", error);
      });
    return () => {
      cancelled = true;
    };
  }, [epsgKey]);

  // The clock is read once per capture, so a default that mixes a field with
  // now() keeps its timestamp when the field is edited afterwards.
  const capturedAtRef = useRef(new Date());
  const capturedLocationRef = useRef<Vertex[] | null>(null);
  const captureKeyRef = useRef(captureKey);
  const recompute = (mode: "capture" | "input") => {
    if (!pending || captureKeyRef.current !== captureKey) {
      captureKeyRef.current = captureKey;
      // The capture ended (saved, cancelled, or the target changed). What it
      // filled in belongs to it: carried into the next capture, an emptied
      // form would read as fields the user had cleared on purpose.
      autoFilledRef.current = {};
      capturedLocationRef.current = null;
      if (!pending) return;
    }
    if (!schema || !hasAttributeFormDefaults(attributeForm)) return;
    // A new clock reading only for a new location, not for the other things
    // that rerun this pass (the projections finishing their load).
    if (mode === "capture" && capturedLocationRef.current !== pending) {
      capturedLocationRef.current = pending;
      capturedAtRef.current = new Date();
    }
    const capturedAt = capturedAtRef.current;
    const current = valuesRef.current;
    const result = applyCaptureDefaults(
      attributeForm,
      current,
      autoFilledRef.current,
      {
        now: () => capturedAt,
        properties: buildPropertiesWithForm(schema, current, attributeForm),
        variables: captureExpressionVariables({
          fix: gpsFix,
          layerName,
          user: currentEditorIdentity(),
        }),
        geometry:
          geometry === "point" && pending[0]
            ? { type: "Point", coordinates: [...pending[0]] }
            : null,
        ...(transform ? { transform } : {}),
      },
      mode,
    );
    autoFilledRef.current = result.autoFilled;
    if (result.values !== current) setValues(result.values);
  };
  const recomputeRef = useRef(recompute);
  recomputeRef.current = recompute;

  // Keyed on what the defaults are, not on the form object: that is rebuilt
  // whenever a referenced layer changes, and rerunning the capture pass then
  // would hand out a new ID mid-form.
  const defaultsKey = (attributeForm?.fields ?? [])
    .map((field) => `${field.field}=${field.defaultValue ?? ""}`)
    .join("\u0000");
  useEffect(() => {
    recomputeRef.current("capture");
  }, [pending, captureKey, gpsFix, schema, defaultsKey, geometry, layerName, transform]);

  // Settles in one extra pass: the values it writes are a fixed point of the
  // same computation, because uuid() is excluded and the clock is held still.
  useEffect(() => {
    recomputeRef.current("input");
  }, [values]);
}
