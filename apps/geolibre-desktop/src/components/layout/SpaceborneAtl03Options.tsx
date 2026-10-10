import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@geolibre/core";
import type { GeoLibreAppAPI } from "@geolibre/plugins";
import { ATL03_SURFACES, type Atl03Surface } from "@geolibre/plugins/atl03";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { SPACEBORNE_LIDAR_SOURCE_KIND } from "../../lib/along-track-profile";
import type { Atl03Granule } from "../../lib/atl03-client";
import { buildSymbologyStyle } from "../../lib/assistant/symbology";
import { baseName } from "../../lib/spaceborne-lidar-samples";

/** Default photon cap: a dense strong beam holds ~10 photons per metre of track. */
const DEFAULT_MAX_PHOTONS = 200_000;
/**
 * Largest view, in degrees of latitude or longitude, read in one go. Photons
 * are read along each beam's whole crossing of the view, so a wide view means
 * hundreds of MB of range requests; zooming in keeps a read interactive.
 */
const MAX_VIEW_DEGREES = 2;
/** Photon clouds read better with smaller points than footprints. */
const PHOTON_RADIUS = 2;
const CONFIDENCE_LEVELS = [0, 1, 2, 3, 4] as const;

interface SpaceborneAtl03OptionsProps {
  granule: Atl03Granule;
  fileName: string;
  appApi: GeoLibreAppAPI;
}

/**
 * The ICESat-2 / GEDI dialog's options for an ATL03 granule, which is read
 * lazily in a worker rather than loaded: ground tracks, the surface whose
 * signal confidence filters the photons, the lowest confidence kept, and a
 * photon cap. Photons are always read for the current map view, since a
 * granule holds millions of them.
 *
 * @param props.granule The granule opened in the ATL03 worker.
 * @param props.fileName The granule's file name, for the layer name.
 * @param props.appApi The host API, for the map view.
 * @returns The options form.
 */
export function SpaceborneAtl03Options({ granule, fileName, appApi }: SpaceborneAtl03OptionsProps) {
  const { t } = useTranslation();
  const [selectedBeams, setSelectedBeams] = useState(
    () => new Set(granule.beams.map((beam) => beam.name)),
  );
  const [surface, setSurface] = useState<Atl03Surface>("land");
  const [minConfidence, setMinConfidence] = useState(2);
  const [maxPoints, setMaxPoints] = useState(String(DEFAULT_MAX_PHOTONS));
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const toggleBeam = (name: string, on: boolean) =>
    setSelectedBeams((current) => {
      const next = new Set(current);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  const handleAdd = async () => {
    setError(null);
    setStatus(null);
    const bbox = appApi.getViewBounds?.() ?? null;
    if (!bbox) {
      setError(t("addData.spaceborneLidar.errorNoView"));
      return;
    }
    const [west, south, east, north] = bbox;
    if (north - south > MAX_VIEW_DEGREES || Math.abs(east - west) > MAX_VIEW_DEGREES) {
      setError(t("addData.spaceborneLidar.atl03.zoomIn", { degrees: MAX_VIEW_DEGREES }));
      return;
    }
    const parsedMax = Number(maxPoints);
    setAdding(true);
    setStatus(t("addData.spaceborneLidar.atl03.reading"));
    try {
      const photons = await granule.readPhotons(
        {
          bbox,
          beams: granule.beams.map((beam) => beam.name).filter((name) => selectedBeams.has(name)),
          minConfidence,
          surface,
          maxPoints: Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : DEFAULT_MAX_PHOTONS,
        },
        // A remote granule reports each range request; show what has arrived.
        (bytes) =>
          setStatus(
            t("addData.spaceborneLidar.atl03.readingProgress", {
              mb: (bytes / 1e6).toFixed(1),
            }),
          ),
      );
      if (photons.kept === 0) {
        setStatus(null);
        setError(t("addData.spaceborneLidar.atl03.noPhotons"));
        return;
      }
      const store = useAppStore.getState();
      const id = store.addGeoJsonLayer(`ATL03 ${baseName(fileName)}`, photons.geojson, fileName);
      store.updateLayer(id, {
        metadata: {
          sourceKind: SPACEBORNE_LIDAR_SOURCE_KIND,
          product: "ATL03",
          beams: photons.perBeam.filter((entry) => entry.kept > 0).map((entry) => entry.beam),
        },
      });
      const layer = useAppStore.getState().layers.find((entry) => entry.id === id);
      let style: Parameters<typeof store.setLayerStyle>[1] = { circleRadius: PHOTON_RADIUS };
      if (layer) {
        try {
          style = {
            ...style,
            ...buildSymbologyStyle(layer, {
              mode: "graduated",
              property: "h_ph",
              colorRamp: "viridis",
              scheme: "quantile",
              classCount: 7,
            }),
          };
        } catch {
          // Too few distinct heights to classify; keep a single color.
        }
      }
      store.setLayerStyle(id, style);
      setStatus(
        photons.stride > 1
          ? t("addData.spaceborneLidar.atl03.addedThinned", {
              kept: photons.kept.toLocaleString(),
              matched: photons.matched.toLocaleString(),
            })
          : t("addData.spaceborneLidar.atl03.added", { kept: photons.kept.toLocaleString() }),
      );
    } catch (err) {
      setStatus(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  };

  return (
    // A div, not a form: it renders inside the dialog's own form.
    <div className="space-y-4" data-testid="spaceborne-atl03-options">
      <p className="text-sm font-medium" data-testid="spaceborne-lidar-product">
        {t("addData.spaceborneLidar.atl03.product")}
      </p>
      <p className="text-xs text-muted-foreground">{t("addData.spaceborneLidar.atl03.help")}</p>

      <div className="space-y-1.5">
        <Label>{t("addData.spaceborneLidar.beamsLabel")}</Label>
        <div className="grid grid-cols-2 gap-1">
          {granule.beams.map((beam) => (
            <label key={beam.name} className="flex cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 rounded border"
                checked={selectedBeams.has(beam.name)}
                onChange={(e) => toggleBeam(beam.name, e.target.checked)}
              />
              <span>
                {beam.name}
                {beam.type ? ` (${beam.type})` : ""}
                <span className="text-muted-foreground">
                  {" "}
                  ·{" "}
                  {t("addData.spaceborneLidar.atl03.photonCount", {
                    count: beam.photons.toLocaleString(),
                  })}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="atl03-surface">{t("addData.spaceborneLidar.atl03.surface")}</Label>
          <Select
            id="atl03-surface"
            value={surface}
            onChange={(e) => setSurface(e.target.value as Atl03Surface)}
          >
            {ATL03_SURFACES.map((value) => (
              <option key={value} value={value}>
                {t(`addData.spaceborneLidar.atl03.surfaces.${value}`)}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="atl03-confidence">{t("addData.spaceborneLidar.atl03.confidence")}</Label>
          <Select
            id="atl03-confidence"
            value={String(minConfidence)}
            onChange={(e) => setMinConfidence(Number(e.target.value))}
          >
            {CONFIDENCE_LEVELS.map((level) => (
              <option key={level} value={level}>
                {t(`addData.spaceborneLidar.atl03.confidenceLevels.${level}`)}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="atl03-max-points">{t("addData.spaceborneLidar.atl03.maxPhotons")}</Label>
        <Input
          id="atl03-max-points"
          type="number"
          min={1}
          value={maxPoints}
          onChange={(e) => setMaxPoints(e.target.value)}
        />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
      {status && (
        <p className="text-xs text-muted-foreground" role="status">
          {status}
        </p>
      )}

      <div className="flex justify-end">
        <Button
          type="button"
          onClick={() => void handleAdd()}
          disabled={adding || selectedBeams.size === 0}
        >
          {adding ? t("addData.spaceborneLidar.adding") : t("addData.spaceborneLidar.atl03.add")}
        </Button>
      </div>
    </div>
  );
}
