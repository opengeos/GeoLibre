import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { Input, Label } from "@geolibre/ui";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/** How far one press of the step buttons moves the tileset, in metres. */
const HEIGHT_OFFSET_STEP = 1;

/**
 * Read a 3D Tiles layer's altitude offset in metres.
 *
 * Only `source.altitudeOffset` is read: it is what every renderer applies, so
 * the field never shows an offset the tileset is not actually drawn with.
 *
 * @param layer - The 3D Tiles layer.
 * @returns The stored offset, or 0 when it is missing or not a finite number.
 */
export function tilesetHeightOffset(layer: GeoLibreLayer): number {
  const value = Number(layer.source.altitudeOffset);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Build the layer patch that stores a new altitude offset.
 *
 * The offset lives on `source.altitudeOffset` (read by every renderer) and is
 * mirrored to `metadata.altitudeOffset`, the way the Add Data flows and the
 * Python builders write it.
 *
 * @param layer - The 3D Tiles layer to update.
 * @param offset - The new offset in metres.
 * @returns The `updateLayer` patch.
 */
export function tilesetHeightOffsetPatch(
  layer: GeoLibreLayer,
  offset: number,
): Pick<GeoLibreLayer, "source" | "metadata"> {
  return {
    source: { ...layer.source, altitudeOffset: offset },
    metadata: { ...layer.metadata, altitudeOffset: offset },
  };
}

/**
 * The Style panel's height field for a 3D tileset (#3107).
 *
 * A model converted from a national CRS often lands above or below the terrain
 * because its heights use a different vertical datum than WGS84, so the user
 * needs to nudge it vertically. The field writes the layer's altitude offset;
 * the globe and the MapLibre 3D Tiles control move the loaded tileset in place.
 *
 * The input keeps its own text while the user types, so a partial value such
 * as "-" or "1." is not overwritten by the stored number mid-entry.
 *
 * @param props - The 3D Tiles layer to edit.
 * @returns The height offset section.
 */
export function TilesetHeightOffsetSection({ layer }: { layer: GeoLibreLayer }) {
  const { t } = useTranslation();
  const updateLayer = useAppStore((s) => s.updateLayer);
  const offset = tilesetHeightOffset(layer);
  const [draft, setDraft] = useState(String(offset));
  const inputId = `tileset-height-offset-${layer.id}`;
  const label = t("style.tilesetHeightOffset");

  // Follow the store when the offset changes elsewhere (the 3D Tiles control's
  // own panel, an undo, another layer selected), unless the draft already
  // means the same number.
  useEffect(() => {
    setDraft((current) =>
      Number(current) === offset && current.trim() !== "" ? current : String(offset),
    );
  }, [offset]);

  const commit = (next: number) => {
    if (!Number.isFinite(next) || next === offset) return;
    updateLayer(layer.id, tilesetHeightOffsetPatch(layer, next));
  };

  const step = (direction: 1 | -1) => {
    const next = Number((offset + direction * HEIGHT_OFFSET_STEP).toFixed(3));
    setDraft(String(next));
    commit(next);
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>{label}</Label>
      <div className="relative">
        <Input
          id={inputId}
          type="number"
          step="any"
          inputMode="decimal"
          className="pe-9 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          value={draft}
          onChange={(event) => {
            const raw = event.target.value;
            setDraft(raw);
            if (raw.trim() !== "") commit(Number(raw));
          }}
          onBlur={() => setDraft(String(offset))}
        />
        <div className="absolute end-1 top-0.5 flex h-8 w-7 flex-col overflow-hidden rounded border bg-background">
          <button
            type="button"
            className="flex h-1/2 items-center justify-center text-foreground hover:bg-accent"
            aria-label={t("style.increaseValue", { label })}
            onClick={() => step(1)}
          >
            <ChevronUp className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="flex h-1/2 items-center justify-center border-t text-foreground hover:bg-accent"
            aria-label={t("style.decreaseValue", { label })}
            onClick={() => step(-1)}
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t("style.tilesetHeightOffsetHint")}</p>
    </div>
  );
}
