import {
  ARCGIS_PROJECTION_PRESETS,
  DEFAULT_PROJECT_PREFERENCES,
  ELLIPSOIDS,
  normalizeArcgisWkid,
  type MapPreferences,
  type MapProjection,
  type MapScaleUnit,
} from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { Crosshair, RotateCcw, TriangleAlert } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  COORDINATE_FORMATS,
  createProjectedReadout,
  normalizeCoordinateEpsgCode,
  normalizeCoordinateFormat,
  parseEpsgCodeInput,
} from "../../../lib/coordinate-format";
import { CrsPickerInput } from "../../processing/CrsPickerInput";
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
  const coordinateFormat = normalizeCoordinateFormat(draftPreferences.map.coordinateFormat);
  const coordinateEpsgCode = normalizeCoordinateEpsgCode(draftPreferences.map.coordinateEpsgCode);
  // The EPSG field's own text, so a half-typed or cleared code stays editable;
  // only a well-formed code is written to the draft.
  const [epsgText, setEpsgText] = useState(() => String(coordinateEpsgCode));
  // Follow a code changed from outside the field (a settings reset).
  useEffect(() => {
    setEpsgText((text) =>
      parseEpsgCodeInput(text) === coordinateEpsgCode ? text : String(coordinateEpsgCode),
    );
  }, [coordinateEpsgCode]);
  // Whether the bundled EPSG tables know the draft code; null while checking.
  const [epsgKnown, setEpsgKnown] = useState<boolean | null>(null);
  useEffect(() => {
    if (coordinateFormat !== "epsg") return;
    let cancelled = false;
    setEpsgKnown(null);
    void createProjectedReadout(coordinateEpsgCode).then((readout) => {
      if (!cancelled) setEpsgKnown(readout !== null);
    });
    return () => {
      cancelled = true;
    };
  }, [coordinateFormat, coordinateEpsgCode]);

  // The ArcGIS projection picker: a preset WKID, "" for Web Mercator, or
  // "custom" with the WKID typed in its own field (issue #2708).
  const arcgisWkid = normalizeArcgisWkid(draftPreferences.map.arcgisWkid);
  const isPresetWkid = ARCGIS_PROJECTION_PRESETS.some((preset) => preset.wkid === arcgisWkid);
  const [customWkid, setCustomWkid] = useState(() => arcgisWkid !== undefined && !isPresetWkid);
  const [wkidText, setWkidText] = useState(() => (arcgisWkid ? String(arcgisWkid) : ""));
  const projectionChoice =
    customWkid || (arcgisWkid !== undefined && !isPresetWkid)
      ? "custom"
      : arcgisWkid === undefined
        ? ""
        : String(arcgisWkid);
  const updateMapPreferences = (patch: Partial<MapPreferences>) => {
    setDraftPreferences((current) => ({
      ...current,
      map: { ...current.map, ...patch },
    }));
    setError(null);
  };

  // A projection only shows on the flat ArcGIS map, so choosing one turns the
  // globe off; going back to Web Mercator leaves the globe setting alone.
  const setArcgisWkid = (wkid: number | undefined) =>
    updateMapPreferences(
      wkid === undefined ? { arcgisWkid: undefined } : { arcgisWkid: wkid, projection: "mercator" },
    );

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
    // The defaults carry no `arcgisWkid`, so clear it explicitly.
    updateMapPreferences({ ...DEFAULT_PROJECT_PREFERENCES.map, arcgisWkid: undefined });
    setCustomWkid(false);
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
        <Label htmlFor="settings-arcgis-projection">{t("settings.map.arcgisProjection")}</Label>
        <Select
          id="settings-arcgis-projection"
          value={projectionChoice}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "custom") {
              setCustomWkid(true);
              const wkid = normalizeArcgisWkid(wkidText);
              if (wkid !== undefined) setArcgisWkid(wkid);
              return;
            }
            setCustomWkid(false);
            const wkid = normalizeArcgisWkid(value);
            if (wkid !== undefined) setWkidText(String(wkid));
            setArcgisWkid(wkid);
          }}
        >
          <option value="">{t("settings.map.arcgisProjectionWebMercator")}</option>
          {ARCGIS_PROJECTION_PRESETS.map((preset) => (
            <option key={preset.id} value={String(preset.wkid)}>
              {`${t(`settings.map.arcgisProjections.${preset.id}`, { defaultValue: preset.name })} (${preset.wkid})`}
            </option>
          ))}
          <option value="custom">{t("settings.map.arcgisProjectionCustom")}</option>
        </Select>
        <p className="text-xs text-muted-foreground">{t("settings.map.arcgisProjectionHint")}</p>
      </div>
      {projectionChoice === "custom" ? (
        <div className="space-y-1.5">
          <Label htmlFor="settings-arcgis-wkid">{t("settings.map.arcgisProjectionWkid")}</Label>
          <Input
            id="settings-arcgis-wkid"
            inputMode="numeric"
            value={wkidText}
            onChange={(event) => {
              const text = event.target.value;
              setWkidText(text);
              const wkid = normalizeArcgisWkid(text);
              if (wkid !== undefined) setArcgisWkid(wkid);
            }}
          />
          <p className="text-xs text-muted-foreground">
            {t("settings.map.arcgisProjectionWkidHint")}
          </p>
        </div>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor="settings-coordinate-format">{t("settings.map.coordinateFormat")}</Label>
        <Select
          id="settings-coordinate-format"
          value={coordinateFormat}
          onChange={(event) => updateMapPreferences({ coordinateFormat: event.target.value })}
        >
          {COORDINATE_FORMATS.map((format) => (
            <option key={format} value={format}>
              {t(`statusBar.coordinateFormat.${format}`, { code: coordinateEpsgCode })}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">{t("settings.map.coordinateFormatHint")}</p>
      </div>
      {coordinateFormat === "epsg" ? (
        <div className="space-y-1.5">
          <Label htmlFor="settings-coordinate-epsg">{t("settings.map.coordinateEpsg")}</Label>
          <CrsPickerInput
            id="settings-coordinate-epsg"
            value={epsgText}
            onChange={(value) => {
              const text = String(value ?? "");
              setEpsgText(text);
              const code = parseEpsgCodeInput(text);
              if (code !== null) updateMapPreferences({ coordinateEpsgCode: code });
            }}
          />
          {epsgKnown === false || parseEpsgCodeInput(epsgText) === null ? (
            <p className="flex items-center gap-1 text-xs text-destructive">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
              {t("settings.map.coordinateEpsgUnknown")}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">{t("settings.map.coordinateEpsgHint")}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
