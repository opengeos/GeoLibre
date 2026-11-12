import type { GeoLibreLayer } from "@geolibre/core";
import { Button } from "@geolibre/ui";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { relatedRecordTargets, type SavedParent } from "../../lib/field-collection";

interface FieldCollectionRelatedProps {
  /** The record just saved, whose children can now be added. */
  parent: SavedParent;
  layers: GeoLibreLayer[];
  /** Switch the capture target to a child layer with its link pre-filled. */
  onAdd: (layerId: string, prefill: Record<string, string>) => void;
}

/**
 * Offers the child records of the record just saved: one button per layer
 * whose form links to the saved record's layer (QGIS relations). Adding one
 * opens that layer's form with the link already set, which is how several
 * photos or reviews end up attached to one point.
 */
export function FieldCollectionRelated({ parent, layers, onAdd }: FieldCollectionRelatedProps) {
  const { t } = useTranslation();
  const targets = relatedRecordTargets(parent, layers);
  if (targets.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-sm text-muted-foreground">{t("fieldCollection.relatedPrompt")}</p>
      {targets.map((target) => (
        <Button
          key={`${target.layerId}-${target.field}`}
          variant="outline"
          className="w-full"
          onClick={() => onAdd(target.layerId, { [target.field]: target.value })}
        >
          <Plus className="me-2 h-4 w-4" />
          {/* Two links into one layer are told apart by the field they fill. */}
          {targets.filter((other) => other.layerId === target.layerId).length > 1
            ? t("fieldCollection.addRelatedVia", {
                layer: target.layerName,
                field: target.fieldLabel,
              })
            : t("fieldCollection.addRelated", { layer: target.layerName })}
        </Button>
      ))}
    </div>
  );
}
