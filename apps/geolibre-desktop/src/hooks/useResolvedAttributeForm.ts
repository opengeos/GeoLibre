import {
  resolveAttributeFormRelations,
  useAppStore,
  type AttributeFormConfig,
} from "@geolibre/core";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

/**
 * A layer's attribute form with its relation dropdowns filled from the layers
 * they reference, as those layers are now.
 *
 * Only the referenced layers' features are subscribed to, so the lists are
 * rebuilt when one of them changes (a record added to a parent layer shows up
 * at once) and not on every edit elsewhere in the project.
 *
 * @param form - The layer's form config, or `undefined` for none.
 * @returns The form with live dropdown entries; `form` itself when it has no
 *   relations or none could be resolved.
 */
export function useResolvedAttributeForm(
  form: AttributeFormConfig | undefined,
): AttributeFormConfig | undefined {
  const relationLayerIds = useMemo(
    () => [
      ...new Set(
        (form?.fields ?? []).flatMap((field) =>
          field.valueRelation ? [field.valueRelation.layerId] : [],
        ),
      ),
    ],
    [form],
  );
  const relationSources = useAppStore(
    useShallow((s) =>
      relationLayerIds.map((id) => s.layers.find((layer) => layer.id === id)?.geojson),
    ),
  );
  return useMemo(
    () =>
      resolveAttributeFormRelations(form, (id) =>
        relationSources[relationLayerIds.indexOf(id)]?.features.map(
          (feature) => feature.properties,
        ),
      ),
    [form, relationLayerIds, relationSources],
  );
}
