import {
  DEFAULT_PROJECT_PREFERENCES,
  ELLIPSOIDS,
  type MapPreferences,
  type MapProjection,
  type MapScaleUnit,
} from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { Crosshair, RotateCcw, TriangleAlert } from "lucide-react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { COORDINATE_FORMATS, normalizeCoordinateFormat } from "../../../lib/coordinate-format";
import { roundCoordinate } from "./settings-draft";
import { useSettingsDraft } from "./SettingsDraftContext";

interface MapSectionProps {
  mapControllerRef: RefObject<MapEngine | null>;
  /**
   * Live map projection, captured when the dialog opens. The Globe projection
   * lets the map drift slightly past restricted bounds, so we warn users to
   * switch to Mercator before capturing the current view (see #505).
   */
  liveProjection: MapProjection | null;
}

/**
 * The Map section: bounds, zoom and pitch constraints and display preferences.
 *
 * Args:
 *   props: The section props.
 *
 * Returns:
 *   The section content.
 */
export function MapSection({ mapControllerRef, liveProjection }: MapSectionProps) {
  const { t } = useTranslation();
  const { draftPreferences, setDraftPreferences, setError } = useSettingsDraft();

  const updateMapPreferences = (patch: Partial<MapPreferences>) => {
    setDraftPreferences((current) => ({
      ...current,
      map: { ...current.map, ...patch },
    }));
    setError(null);
  };

  const updateBoundsValue = (index: number, value: number) => {
    // Ignore a cleared field (valueAsNumber is NaN) so it does not silently
    // become an edge-of-range value on save; the last valid value is kept.
    if (!Number.isFinite(value)) return;
    setDraftPreferences((current) => {
      const bounds: MapPreferences["bounds"] = [...current.map.bounds];
      bounds[index] = value;
      return {
        ...current,
        map: { ...current.map, bounds },
      };
    });
    setError(null);
  };

  const applyCurrentViewBounds = () => {
    const bounds = mapControllerRef.current?.readView().bbox;
    if (!bounds) {
      setError(t("settings.map.errorBoundsUnavailable"));
      return;
    }
    updateMapPreferences({
      restrictBounds: true,
      bounds: [
        roundCoordinate(bounds[0]),
        roundCoordinate(bounds[1]),
        roundCoordinate(bounds[2]),
        roundCoordinate(bounds[3]),
      ],
    });
  };

  const resetMapPreferences = () => {
    updateMapPreferences(DEFAULT_PROJECT_PREFERENCES.map);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{t("settings.map.constraintsTitle")}</h3>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={resetMapPreferences}>
          <RotateCcw className="h-3.5 w-3.5" />
          {t("common.reset")}
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            className="h-4 w-4"
            type="checkbox"
            checked={draftPreferences.map.restrictBounds}
            onChange={(event) =>
              updateMapPreferences({
                restrictBounds: event.target.checked,
              })
            }
          />
          {t("settings.map.restrictBounds")}
        </label>
        <Button
          type="button"
          size="sm"
          variant="outline"
          title={t("settings.map.useCurrentViewHint")}
          onClick={applyCurrentViewBounds}
        >
          <Crosshair className="h-3.5 w-3.5" />
          {t("settings.map.useCurrentView")}
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {(
          [
            ["settings.map.west", 0, -180, 180],
            ["settings.map.south", 1, -85, 85],
            ["settings.map.east", 2, -180, 180],
            ["settings.map.north", 3, -85, 85],
          ] as const
        ).map(([labelKey, index, min, max]) => (
          <div key={labelKey} className="space-y-1.5">
            <Label
              htmlFor={`settings-bounds-${index}`}
              className={
                draftPreferences.map.restrictBounds ? undefined : "cursor-not-allowed opacity-50"
              }
            >
              {t(labelKey)}
            </Label>
            <Input
              id={`settings-bounds-${index}`}
              type="number"
              min={min}
              max={max}
              step="0.000001"
              disabled={!draftPreferences.map.restrictBounds}
              value={draftPreferences.map.bounds[index as number]}
              onChange={(event) => updateBoundsValue(index as number, event.target.valueAsNumber)}
            />
          </div>
        ))}
      </div>
      {liveProjection === "globe" ? (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span>{t("settings.map.useCurrentViewGlobeHint")}</span>
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="settings-min-zoom">{t("settings.map.minZoom")}</Label>
          <Input
            id="settings-min-zoom"
            type="number"
            min={0}
            max={24}
            step={0.25}
            value={draftPreferences.map.minZoom}
            onChange={(event) =>
              updateMapPreferences({
                minZoom: event.target.valueAsNumber,
              })
            }
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="settings-max-zoom">{t("settings.map.maxZoom")}</Label>
          <Input
            id="settings-max-zoom"
            type="number"
            min={0}
            max={24}
            step={0.25}
            value={draftPreferences.map.maxZoom}
            onChange={(event) =>
              updateMapPreferences({
                maxZoom: event.target.valueAsNumber,
              })
            }
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="settings-max-pitch">{t("settings.map.maxPitch")}</Label>
          <Input
            id="settings-max-pitch"
            type="number"
            min={0}
            max={85}
            step={1}
            value={draftPreferences.map.maxPitch}
            onChange={(event) =>
              updateMapPreferences({
                maxPitch: event.target.valueAsNumber,
              })
            }
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          className="h-4 w-4"
          type="checkbox"
          checked={draftPreferences.map.renderWorldCopies}
          onChange={(event) =>
            updateMapPreferences({
              renderWorldCopies: event.target.checked,
            })
          }
        />
        {t("settings.map.renderWorldCopies")}
      </label>
      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm">
          <input
            className="h-4 w-4"
            type="checkbox"
            checked={draftPreferences.map.zoomToNewLayers}
            onChange={(event) =>
              updateMapPreferences({
                zoomToNewLayers: event.target.checked,
              })
            }
          />
          {t("settings.map.zoomToNewLayers")}
        </label>
        <p className="ps-6 text-xs text-muted-foreground">
          {t("settings.map.zoomToNewLayersHint")}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="settings-ellipsoid">{t("settings.map.ellipsoid")}</Label>
        <Select
          id="settings-ellipsoid"
          value={draftPreferences.map.ellipsoidId}
          onChange={(event) =>
            updateMapPreferences({
              ellipsoidId: event.target.value,
            })
          }
        >
          {ELLIPSOIDS.map((ellipsoid) => (
            <option key={ellipsoid.id} value={ellipsoid.id}>
              {ellipsoid.name}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">{t("settings.map.ellipsoidHint")}</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="settings-scale-unit">{t("settings.map.scaleUnit")}</Label>
        <Select
          id="settings-scale-unit"
          value={draftPreferences.map.scaleUnit}
          onChange={(event) =>
            updateMapPreferences({
              scaleUnit: event.target.value as MapScaleUnit,
            })
          }
        >
          <option value="metric">{t("settings.map.scaleUnitMetric")}</option>
          <option value="imperial">{t("settings.map.scaleUnitImperial")}</option>
          <option value="nautical">{t("settings.map.scaleUnitNautical")}</option>
        </Select>
        <p className="text-xs text-muted-foreground">{t("settings.map.scaleUnitHint")}</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="settings-coordinate-format">{t("settings.map.coordinateFormat")}</Label>
        <Select
          id="settings-coordinate-format"
          value={normalizeCoordinateFormat(draftPreferences.map.coordinateFormat)}
          onChange={(event) => updateMapPreferences({ coordinateFormat: event.target.value })}
        >
          {COORDINATE_FORMATS.map((format) => (
            <option key={format} value={format}>
              {t(`statusBar.coordinateFormat.${format}`)}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">{t("settings.map.coordinateFormatHint")}</p>
      </div>
    </div>
  );
}
