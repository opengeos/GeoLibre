import { currentEditorIdentity, type AttributeFormConfig } from "@geolibre/core";
import { useEffect, useRef, useState } from "react";
import {
  applyCaptureDefaults,
  captureExpressionVariables,
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

  useEffect(() => {
    let cancelled = false;
    setTransform(null);
    void loadDefaultValueTransform(attributeForm).then((loaded) => {
      // Wrapped: a bare function passed to a state setter is called as an updater.
      if (!cancelled && loaded) setTransform(() => loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [attributeForm]);

  const recompute = (mode: "capture" | "input") => {
    if (!pending || !schema || !hasAttributeFormDefaults(attributeForm)) return;
    const current = valuesRef.current;
    const result = applyCaptureDefaults(
      attributeForm,
      current,
      autoFilledRef.current,
      {
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

  useEffect(() => {
    recomputeRef.current("capture");
  }, [pending, gpsFix, schema, attributeForm, geometry, layerName, transform]);

  // Settles in one extra pass: the values it writes are a fixed point of the
  // same computation, because volatile defaults are excluded in this mode.
  useEffect(() => {
    recomputeRef.current("input");
  }, [values]);
}
