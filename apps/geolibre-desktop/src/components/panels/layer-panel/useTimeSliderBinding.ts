import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@geolibre/core";
import type { GeoLibreLayer } from "@geolibre/core";
import {
  buildTimeBindingFromRecords,
  detectTimePropertiesFromRecords,
  formatTimeExtentInput,
  isTileVectorLayer,
  parseTimeValue,
  sampleTileFeatureRecords,
  type TimePropertyCandidate,
  type TimePropertyRecord,
} from "@geolibre/plugins";
import type { MapEngine } from "@geolibre/map";
import { activateTimeSliderForBinding } from "../../../hooks/usePlugins";
import { resolveLayerGeojson } from "../../../lib/vector-export";

export type BindWindowMode = "step" | "wide" | "wider" | "cumulative";

interface UseTimeSliderBindingOptions {
  /** The project's layers, used to resolve (and drop) the dialog's target. */
  layers: GeoLibreLayer[];
  mapControllerRef: RefObject<MapEngine | null>;
}

/**
 * State and handlers for the "Bind to Time Slider" dialog: detecting a layer's
 * timestamp columns, the chosen property/window/extent, and committing the
 * binding to the layer metadata.
 *
 * @param options - The layers and the map controller.
 * @returns The dialog state, its setters, and the open/close/confirm handlers.
 */
export function useTimeSliderBinding({ layers, mapControllerRef }: UseTimeSliderBindingOptions) {
  const { t } = useTranslation();
  const updateLayer = useAppStore((s) => s.updateLayer);
  // Time Slider binding dialog: the target layer, the detected timestamp
  // columns, the chosen property, and the window width. `candidates` is null
  // while the layer's features are still being inspected.
  const [bindTimeSliderLayerId, setBindTimeSliderLayerId] = useState<string | null>(null);
  const [bindCandidates, setBindCandidates] = useState<TimePropertyCandidate[] | null>(null);
  const [bindProperty, setBindProperty] = useState("");
  const [bindWindowMode, setBindWindowMode] = useState<BindWindowMode>("step");
  // Feature properties resolved when the bind dialog opens, reused on confirm so
  // a large layer is scanned only once. A GeoJSON layer contributes every
  // feature; a tile layer contributes the features of its loaded tiles.
  const [bindRecords, setBindRecords] = useState<TimePropertyRecord[] | null>(null);
  // True when the target layer draws from vector tiles, so the scanned extent
  // covers only the loaded tiles and the dialog offers it for editing.
  const [bindIsTileLayer, setBindIsTileLayer] = useState(false);
  // The editable extent, as the text shown in the inputs (a year, or an ISO
  // date). Empty until a property is chosen and its extent is prefilled.
  const [bindRangeStart, setBindRangeStart] = useState("");
  const [bindRangeEnd, setBindRangeEnd] = useState("");
  // Shown in the dialog when binding fails (e.g. the chosen property has no
  // parseable timestamps) instead of closing the dialog with no feedback.
  const [bindError, setBindError] = useState<string | null>(null);
  // Monotonic token for the active bind request. Each open/close bumps it, so a
  // stale async scan or confirm (even for the same layer reopened) is dropped
  // when it no longer matches the latest token.
  const bindRequestRef = useRef(0);

  const bindTimeSliderLayer = bindTimeSliderLayerId
    ? (layers.find((layer) => layer.id === bindTimeSliderLayerId) ?? null)
    : null;

  // Close the bind dialog and invalidate any in-flight scan/confirm so a late
  // async result cannot reopen it, write stale candidates, or bind after cancel.
  const closeBindTimeSliderDialog = useCallback(() => {
    bindRequestRef.current += 1;
    setBindTimeSliderLayerId(null);
  }, []);

  // Fill the extent inputs from a property's scanned range. The upper bound is
  // rounded up so a partial trailing day/year is not cut off the timeline.
  const prefillBindRange = useCallback((records: TimePropertyRecord[], property: string) => {
    const provisional = buildTimeBindingFromRecords(records, property);
    setBindRangeStart(
      provisional ? formatTimeExtentInput(provisional.min, provisional.valueKind) : "",
    );
    setBindRangeEnd(
      provisional ? formatTimeExtentInput(provisional.max, provisional.valueKind, true) : "",
    );
  }, []);

  // Open the bind dialog: inspect the layer's features for timestamp columns and
  // preselect the best-covered one. `candidates` stays null until detection
  // finishes so the dialog can show a "scanning" state for large layers.
  const openBindTimeSliderDialog = useCallback(
    async (layer: GeoLibreLayer) => {
      // Tag this request with a fresh token so a stale async scan (open ->
      // close/reopen, even for the same layer) cannot populate this dialog.
      const token = (bindRequestRef.current += 1);
      setBindTimeSliderLayerId(layer.id);
      setBindCandidates(null);
      setBindProperty("");
      setBindWindowMode("step");
      setBindRecords(null);
      setBindRangeStart("");
      setBindRangeEnd("");
      setBindError(null);
      const isTileLayer = isTileVectorLayer(layer);
      setBindIsTileLayer(isTileLayer);
      try {
        const map = mapControllerRef.current?.getMap() ?? undefined;
        // A tile layer has no feature collection to scan — read the features of
        // its currently loaded tiles instead. That sample is enough to find the
        // timestamp column and how it stores its values; the extent it yields
        // covers only those tiles, so the dialog prefills it as an editable
        // range rather than treating it as the data's true span.
        const records: TimePropertyRecord[] = isTileLayer
          ? sampleTileFeatureRecords(map, layer)
          : ((await resolveLayerGeojson(layer, map))?.features ?? []).map(
              (feature) => feature?.properties,
            );
        if (bindRequestRef.current !== token) return;
        const candidates = detectTimePropertiesFromRecords(records);
        setBindRecords(records);
        setBindCandidates(candidates);
        if (candidates.length > 0) {
          setBindProperty(candidates[0].property);
          if (isTileLayer) prefillBindRange(records, candidates[0].property);
        }
      } catch {
        if (bindRequestRef.current !== token) return;
        setBindRecords([]);
        setBindCandidates([]);
      }
    },
    [mapControllerRef, prefillBindRange],
  );

  // Commit a binding: persist it on the layer metadata and activate the Time
  // Slider so it adopts the binding and drives the filter. Styling/opacity are
  // untouched; only the visible feature set narrows as the timeline moves.
  const confirmBindTimeSlider = useCallback(() => {
    const layer = bindTimeSliderLayer;
    // The records resolved when the dialog opened are reused here, so a large
    // layer is scanned only once.
    if (!layer || !bindProperty || !bindRecords) return;
    // Only a tile layer offers an editable extent: its scan saw just the loaded
    // tiles. A GeoJSON layer's scanned extent is exact and is used as-is.
    let extent: { min: number; max: number } | undefined;
    if (bindIsTileLayer) {
      const min = parseTimeValue(bindRangeStart);
      const max = parseTimeValue(bindRangeEnd);
      if (min === null || max === null) {
        setBindError(t("layers.bindRangeInvalid"));
        return;
      }
      extent = { min, max };
    }
    const binding = buildTimeBindingFromRecords(bindRecords, bindProperty, {
      extent,
    });
    if (!binding) {
      // Keep the dialog open and explain why, rather than closing silently.
      setBindError(t("layers.bindNoTimestamps"));
      return;
    }
    // A cumulative binding still steps one granularity unit at a time; what
    // changes is that the lower bound stays anchored at the start of the data.
    const timeWindow =
      bindWindowMode === "wider"
        ? { unit: binding.granularity, before: 3, after: 3 }
        : bindWindowMode === "wide"
          ? { unit: binding.granularity, before: 1, after: 1 }
          : { unit: binding.granularity, before: 0, after: 1 };
    // Re-read the layer before merging: the dialog stays open across an async
    // scan, so an auto-refresh or a concurrent edit can have replaced the
    // metadata since the last render, and spreading the render-time copy would
    // write those changes back out.
    const current = useAppStore.getState().layers.find((entry) => entry.id === layer.id);
    if (!current) return;
    updateLayer(layer.id, {
      metadata: {
        ...current.metadata,
        timeBinding: {
          ...binding,
          window: timeWindow,
          cumulative: bindWindowMode === "cumulative",
        },
      },
      timeFilter: undefined,
    });
    activateTimeSliderForBinding(mapControllerRef);
    closeBindTimeSliderDialog();
  }, [
    bindTimeSliderLayer,
    bindIsTileLayer,
    bindProperty,
    bindRangeEnd,
    bindRangeStart,
    bindRecords,
    bindWindowMode,
    mapControllerRef,
    updateLayer,
    closeBindTimeSliderDialog,
    t,
  ]);

  // Close the dialog (and invalidate its in-flight scan) once its layer is removed.
  useEffect(() => {
    if (bindTimeSliderLayerId && !layers.some((layer) => layer.id === bindTimeSliderLayerId)) {
      bindRequestRef.current += 1;
      setBindTimeSliderLayerId(null);
    }
  }, [bindTimeSliderLayerId, layers]);

  return {
    bindTimeSliderLayerId,
    bindCandidates,
    bindProperty,
    setBindProperty,
    bindWindowMode,
    setBindWindowMode,
    bindRecords,
    bindIsTileLayer,
    bindRangeStart,
    setBindRangeStart,
    bindRangeEnd,
    setBindRangeEnd,
    bindError,
    setBindError,
    prefillBindRange,
    openBindTimeSliderDialog,
    closeBindTimeSliderDialog,
    confirmBindTimeSlider,
  };
}

/** The bind-dialog state and handlers {@link useTimeSliderBinding} returns. */
export type TimeSliderBinding = ReturnType<typeof useTimeSliderBinding>;
