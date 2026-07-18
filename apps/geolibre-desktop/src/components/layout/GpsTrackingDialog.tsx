import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Feature, FeatureCollection } from "geojson";
import maplibregl from "maplibre-gl";
import type { MapController } from "@geolibre/map";
import { useAppStore } from "@geolibre/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  ScrollArea,
  Separator,
} from "@geolibre/ui";
import {
  Circle,
  Download,
  LocateFixed,
  MapPin,
  Maximize2,
  Pause,
  Play,
  Save,
  Square,
  Trash2,
} from "lucide-react";
import {
  buildTrackGpx,
  capturePointFeature,
  DEFAULT_GPS_SETTINGS,
  accuracyCircle,
  fixFromPosition,
  fixMeetsAccuracy,
  formatDistance,
  formatDuration,
  formatSpeedKmh,
  GPS_CAPTURE_FLAG,
  GPS_TRACK_FLAG,
  type GpsFix,
  type GpsTrackSegments,
  type GpsTrackingSettings,
  isGpsCaptureLayer,
  lineSegments,
  normalizeGpsSettings,
  shouldLogFix,
  trackFeatureCollection,
  trackPreview,
  trackStats,
} from "../../lib/gps-tracking";
import { saveTextFileWithFallback } from "../../lib/tauri-io";

interface GpsTrackingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapControllerRef: React.RefObject<MapController | null>;
}

/** Transient map sources for the live position overlays (not store layers, so
 * per-fix updates stay off the undo history and the layer-sync loop). */
const ACCURACY_SOURCE = "__gps_accuracy__";
const TRACK_SOURCE = "__gps_track__";
/** Position marker/accuracy blue; readable on light and dark basemaps. */
const GPS_COLOR = "#2563eb";
/** Live track-log line red, matching the field-collection draw color. */
const TRACK_COLOR = "#ef4444";

const GPS_SETTINGS_STORAGE_KEY = "geolibre.gpsTracking.settings";

const EMPTY_FC: FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

function loadStoredSettings(): GpsTrackingSettings {
  try {
    const raw = window.localStorage.getItem(GPS_SETTINGS_STORAGE_KEY);
    if (raw) return normalizeGpsSettings(JSON.parse(raw));
  } catch {
    // Corrupt or unavailable storage falls through to the defaults.
  }
  return { ...DEFAULT_GPS_SETTINGS };
}

function storeSettings(settings: GpsTrackingSettings): void {
  try {
    window.localStorage.setItem(GPS_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Best-effort persistence; the session keeps the in-memory values.
  }
}

/** Position marker: a blue dot with a heading arrow, rotated per fix. */
function createMarkerElement(): { root: HTMLDivElement; arrow: HTMLDivElement } {
  const root = document.createElement("div");
  root.style.width = "22px";
  root.style.height = "22px";
  root.style.position = "relative";
  const arrow = document.createElement("div");
  arrow.style.position = "absolute";
  arrow.style.left = "50%";
  arrow.style.top = "-9px";
  arrow.style.transform = "translateX(-50%)";
  arrow.style.width = "0";
  arrow.style.height = "0";
  arrow.style.borderLeft = "6px solid transparent";
  arrow.style.borderRight = "6px solid transparent";
  arrow.style.borderBottom = `9px solid ${GPS_COLOR}`;
  arrow.style.display = "none";
  const dot = document.createElement("div");
  dot.style.position = "absolute";
  dot.style.inset = "3px";
  dot.style.borderRadius = "9999px";
  dot.style.background = GPS_COLOR;
  dot.style.border = "2px solid #ffffff";
  dot.style.boxShadow = "0 0 4px rgba(0, 0, 0, 0.35)";
  root.append(arrow, dot);
  return { root, arrow };
}

/** Lazily (re-)register the overlay sources/layers; heals basemap switches. */
function ensureGpsSources(map: maplibregl.Map): void {
  // addSource/addLayer throw while a replacement style is still loading; skip
  // and let the styledata subscription (or the next fix) register them once
  // the style has settled.
  if (!map.isStyleLoaded()) return;
  if (!map.getSource(ACCURACY_SOURCE)) {
    map.addSource(ACCURACY_SOURCE, { type: "geojson", data: EMPTY_FC });
  }
  if (!map.getLayer(`${ACCURACY_SOURCE}-fill`)) {
    map.addLayer({
      id: `${ACCURACY_SOURCE}-fill`,
      type: "fill",
      source: ACCURACY_SOURCE,
      paint: { "fill-color": GPS_COLOR, "fill-opacity": 0.15 },
    });
  }
  if (!map.getSource(TRACK_SOURCE)) {
    map.addSource(TRACK_SOURCE, { type: "geojson", data: EMPTY_FC });
  }
  if (!map.getLayer(`${TRACK_SOURCE}-line`)) {
    map.addLayer({
      id: `${TRACK_SOURCE}-line`,
      type: "line",
      source: TRACK_SOURCE,
      paint: {
        "line-color": TRACK_COLOR,
        "line-width": 3,
        "line-opacity": 0.9,
      },
    });
  }
}

function setSourceData(
  map: maplibregl.Map,
  sourceId: string,
  data: FeatureCollection | Feature,
): void {
  const src = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
  src?.setData(data);
}

function removeGpsSources(map: maplibregl.Map): void {
  try {
    for (const id of [`${ACCURACY_SOURCE}-fill`, `${TRACK_SOURCE}-line`]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    for (const id of [ACCURACY_SOURCE, TRACK_SOURCE]) {
      if (map.getSource(id)) map.removeSource(id);
    }
  } catch {
    // Mid-style-switch the overlays are already gone with the old style;
    // there is nothing left to tear down.
  }
}

type RecordingState = "off" | "recording" | "paused";

/**
 * GPS Tracking (issue #1316): stream the device position onto the map with an
 * accuracy circle and heading marker, optionally keep the map centered, record
 * a timestamped track log with distance/duration stats and min-distance /
 * min-time / accuracy filters, save the track as a layer or export it as
 * GPX/GeoJSON, and capture point features at the current position.
 *
 * The live overlays are transient map sources — only saved tracks and captured
 * points become store layers, so per-fix updates never touch undo history.
 */
export function GpsTrackingDialog({
  open,
  onOpenChange,
  mapControllerRef,
}: GpsTrackingDialogProps) {
  const { t } = useTranslation();
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const updateLayer = useAppStore((s) => s.updateLayer);
  const setGpsStatus = useAppStore((s) => s.setGpsStatus);

  const [tracking, setTracking] = useState(false);
  const [follow, setFollow] = useState(true);
  const [recording, setRecording] = useState<RecordingState>("off");
  const [lastFix, setLastFix] = useState<GpsFix | null>(null);
  const [fixCount, setFixCount] = useState(0);
  const [capturedCount, setCapturedCount] = useState(0);
  const [settings, setSettings] = useState<GpsTrackingSettings>(loadStoredSettings);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const markerRef = useRef<maplibregl.Marker | null>(null);
  const markerArrowRef = useRef<HTMLDivElement | null>(null);
  // Logged track fixes as pause/resume segments; a ref so the high-frequency
  // watch callback appends in place without re-creating itself, with
  // `fixCount` mirroring the total for renders. Always holds >= 1 segment.
  const fixesRef = useRef<GpsTrackSegments>([[]]);
  const lastFixRef = useRef<GpsFix | null>(null);
  const recordingRef = useRef<RecordingState>("off");
  const followRef = useRef(true);
  const settingsRef = useRef(settings);
  // First fix after starting zooms the map in; later fixes only pan.
  const zoomedRef = useRef(false);

  // Update the ref before the state so a fix arriving between a transition
  // and the re-render is logged (or not) under the new recording state.
  const changeRecording = useCallback((next: RecordingState) => {
    recordingRef.current = next;
    setRecording(next);
  }, []);
  useEffect(() => {
    followRef.current = follow;
  }, [follow]);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const getMap = useCallback(() => mapControllerRef.current?.getMap() ?? null, [mapControllerRef]);

  const handleFix = useCallback(
    (fix: GpsFix) => {
      lastFixRef.current = fix;
      setLastFix(fix);
      setError(null);
      setGpsStatus({
        lng: fix.lng,
        lat: fix.lat,
        accuracy: fix.accuracy,
        speed: fix.speed,
        timestamp: fix.timestamp,
      });

      // Log to the track first: which fixes belong in the recording must not
      // depend on whether the map object happens to be available right now.
      let logged = false;
      if (recordingRef.current === "recording") {
        const segment = fixesRef.current[fixesRef.current.length - 1];
        const prev = segment[segment.length - 1] ?? null;
        if (shouldLogFix(prev, fix, settingsRef.current)) {
          segment.push(fix);
          setFixCount((n) => n + 1);
          logged = true;
        }
      }

      const map = getMap();
      if (map) {
        ensureGpsSources(map);
        setSourceData(map, ACCURACY_SOURCE, accuracyCircle(fix));
        // Redraw the track only when a fix was actually logged; the styledata
        // listener below re-seeds the source if a basemap switch wipes it.
        if (logged) {
          setSourceData(map, TRACK_SOURCE, trackPreview(fixesRef.current));
        }
        if (!markerRef.current) {
          const { root, arrow } = createMarkerElement();
          markerArrowRef.current = arrow;
          markerRef.current = new maplibregl.Marker({
            element: root,
            rotationAlignment: "map",
            pitchAlignment: "map",
          })
            .setLngLat([fix.lng, fix.lat])
            .addTo(map);
        } else {
          markerRef.current.setLngLat([fix.lng, fix.lat]);
        }
        if (markerArrowRef.current) {
          markerArrowRef.current.style.display = fix.heading != null ? "block" : "none";
        }
        if (fix.heading != null) markerRef.current.setRotation(fix.heading);

        if (followRef.current) {
          map.easeTo({
            center: [fix.lng, fix.lat],
            duration: 500,
            ...(zoomedRef.current ? {} : { zoom: Math.max(map.getZoom(), 15) }),
          });
          zoomedRef.current = true;
        }
      }
    },
    [getMap, setGpsStatus],
  );

  // The watchPosition subscription follows `tracking`.
  useEffect(() => {
    if (!tracking) return;
    if (!("geolocation" in navigator)) {
      setError(t("gps.noGeolocation"));
      setTracking(false);
      return;
    }
    zoomedRef.current = false;
    const id = navigator.geolocation.watchPosition(
      (pos) => handleFix(fixFromPosition(pos)),
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setError(t("gps.permissionDenied"));
          setTracking(false);
        } else {
          // Transient (no signal / timeout): keep watching, tell the user.
          setError(t("gps.waitingForFix"));
        }
      },
      { enableHighAccuracy: true, maximumAge: 0 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [tracking, handleFix, t]);

  // Map subscriptions while tracking. Manual panning turns follow mode off,
  // QGIS-style, so the map stays where the user dragged it instead of snapping
  // back on the next fix; the styledata listener re-registers the overlay
  // sources after a basemap switch (map.setStyle wipes custom sources) and
  // re-seeds them from the recorded fixes. The map may not be mounted yet when
  // tracking starts, so retry until it is rather than silently skipping the
  // subscriptions for the whole session.
  useEffect(() => {
    if (!tracking) return;
    const onDragStart = () => setFollow(false);
    // Gated on the source actually being gone, so the frequent styledata
    // events fired by ordinary style mutations cost one getSource() check.
    const onStyleData = () => {
      const m = getMap();
      if (!m || m.getSource(TRACK_SOURCE)) return;
      ensureGpsSources(m);
      const fix = lastFixRef.current;
      if (fix) setSourceData(m, ACCURACY_SOURCE, accuracyCircle(fix));
      setSourceData(m, TRACK_SOURCE, trackPreview(fixesRef.current));
    };
    let map: maplibregl.Map | null = null;
    let timer: number | undefined;
    const attach = () => {
      map = getMap();
      if (map) {
        map.on("dragstart", onDragStart);
        map.on("styledata", onStyleData);
        return;
      }
      timer = window.setTimeout(attach, 500);
    };
    attach();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      map?.off("dragstart", onDragStart);
      map?.off("styledata", onStyleData);
    };
  }, [tracking, getMap]);

  const clearMapArtifacts = useCallback(() => {
    markerRef.current?.remove();
    markerRef.current = null;
    markerArrowRef.current = null;
    const map = getMap();
    if (map) removeGpsSources(map);
  }, [getMap]);

  // When tracking stops, clear the overlays and the status-bar readout. An
  // in-progress recording pauses (rather than being lost) so the fixes can
  // still be saved or exported from the dialog.
  useEffect(() => {
    if (tracking) return;
    clearMapArtifacts();
    setGpsStatus(null);
    setLastFix(null);
    lastFixRef.current = null;
    if (recordingRef.current === "recording") changeRecording("paused");
  }, [tracking, clearMapArtifacts, setGpsStatus, changeRecording]);

  // Full teardown on unmount (the component normally stays mounted for the
  // whole session; this covers shell re-composition).
  useEffect(
    () => () => {
      clearMapArtifacts();
      useAppStore.getState().setGpsStatus(null);
    },
    [clearMapArtifacts],
  );

  const updateSettings = useCallback((patch: Partial<GpsTrackingSettings>) => {
    setSettings((prev) => {
      const next = normalizeGpsSettings({ ...prev, ...patch });
      storeSettings(next);
      return next;
    });
  }, []);

  const handleStart = useCallback(() => {
    setError(null);
    setNotice(null);
    setTracking(true);
  }, []);

  const handleStop = useCallback(() => {
    setTracking(false);
  }, []);

  const clearTrack = useCallback(() => {
    fixesRef.current = [[]];
    setFixCount(0);
    const map = getMap();
    if (map) setSourceData(map, TRACK_SOURCE, EMPTY_FC);
  }, [getMap]);

  const handleStartRecording = useCallback(() => {
    clearTrack();
    changeRecording("recording");
    setNotice(null);
    if (!tracking) handleStart();
  }, [clearTrack, changeRecording, tracking, handleStart]);

  const handleDiscardTrack = useCallback(() => {
    clearTrack();
    changeRecording("off");
    setNotice(null);
  }, [clearTrack, changeRecording]);

  const handleResumeRecording = useCallback(() => {
    // A pause/resume boundary starts a new segment, so the stretch travelled
    // while paused is never drawn or measured as if it had been walked.
    const segments = fixesRef.current;
    if (segments[segments.length - 1].length > 0) segments.push([]);
    changeRecording("recording");
    if (!tracking) handleStart();
  }, [changeRecording, tracking, handleStart]);

  const trackName = useCallback(() => {
    const first = fixesRef.current.flat()[0];
    const stamp = new Date(first ? first.timestamp : Date.now());
    // Local wall-clock start time, filename-safe (no colons).
    const pad = (n: number) => String(n).padStart(2, "0");
    const label = `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(
      stamp.getDate(),
    )} ${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;
    return `${t("gps.trackLayerName")} ${label}`;
  }, [t]);

  const handleSaveTrack = useCallback(() => {
    if (lineSegments(fixesRef.current).length === 0) return;
    const name = trackName();
    const id = addGeoJsonLayer(name, trackFeatureCollection(fixesRef.current));
    updateLayer(id, { metadata: { [GPS_TRACK_FLAG]: true } });
    clearTrack();
    changeRecording("off");
    setNotice(t("gps.trackSaved", { name }));
  }, [trackName, addGeoJsonLayer, updateLayer, clearTrack, changeRecording, t]);

  const handleExportTrack = useCallback(
    async (format: "gpx" | "geojson") => {
      if (lineSegments(fixesRef.current).length === 0) return;
      const name = trackName();
      const content =
        format === "gpx"
          ? buildTrackGpx(fixesRef.current, name)
          : JSON.stringify(trackFeatureCollection(fixesRef.current), null, 2);
      try {
        const path = await saveTextFileWithFallback(content, {
          defaultName: `${name.replace(/[\\/:]+/g, "-")}.${format}`,
          filters: [
            format === "gpx"
              ? { name: "GPX", extensions: ["gpx"] }
              : { name: "GeoJSON", extensions: ["geojson", "json"] },
          ],
          browserTypes: [
            format === "gpx"
              ? { description: "GPX", accept: { "application/gpx+xml": [".gpx"] } }
              : {
                  description: "GeoJSON",
                  accept: { "application/geo+json": [".geojson", ".json"] },
                },
          ],
          mimeType: format === "gpx" ? "application/gpx+xml" : "application/geo+json",
        });
        setNotice(path ? t("gps.trackExported") : t("gps.exportCancelled"));
      } catch {
        setNotice(t("gps.exportFailed"));
      }
    },
    [trackName, t],
  );

  const handleCapturePoint = useCallback(() => {
    const fix = lastFixRef.current;
    if (!fix) return;
    if (!fixMeetsAccuracy(fix, settingsRef.current)) {
      setNotice(
        t("gps.captureBlocked", {
          accuracy: Math.round(fix.accuracy),
          max: settingsRef.current.maxAccuracyM,
        }),
      );
      return;
    }
    // Read live state so captures after a layer rename/removal stay correct.
    const state = useAppStore.getState();
    let layer = state.layers.find((l) => isGpsCaptureLayer(l));
    if (!layer) {
      const id = state.addGeoJsonLayer(t("gps.captureLayerName"), {
        type: "FeatureCollection",
        features: [],
      });
      state.updateLayer(id, { metadata: { [GPS_CAPTURE_FLAG]: true } });
      layer = useAppStore.getState().layers.find((l) => l.id === id);
    }
    if (!layer) return;
    const fc = layer.geojson ?? { type: "FeatureCollection" as const, features: [] };
    useAppStore.getState().updateLayer(layer.id, {
      geojson: {
        type: "FeatureCollection",
        features: [...fc.features, capturePointFeature(fix)],
      },
    });
    setCapturedCount((n) => n + 1);
    setNotice(t("gps.pointCaptured", { layer: layer.name }));
  }, [t]);

  const stats = trackStats(fixesRef.current);
  // `fixCount` in the guard keeps this recomputed as fixes arrive.
  const canSaveTrack = fixCount >= 2 && lineSegments(fixesRef.current).length > 0;
  const showPanel = tracking && !open;

  return (
    <>
      {showPanel && (
        <FloatingPanel
          fix={lastFix}
          recording={recording}
          stats={stats}
          capturedCount={capturedCount}
          onCapture={handleCapturePoint}
          onPause={() => changeRecording("paused")}
          onResume={handleResumeRecording}
          onOpen={() => onOpenChange(true)}
        />
      )}

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("gps.title")}</DialogTitle>
            <DialogDescription>{t("gps.description")}</DialogDescription>
          </DialogHeader>

          <ScrollArea className="max-h-[65vh] pe-3">
            <div className="space-y-4 py-1">
              {/* Live position */}
              <div className="space-y-2">
                {tracking ? (
                  <>
                    <FixReadout fix={lastFix} />
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={follow}
                        onChange={(e) => setFollow(e.target.checked)}
                      />
                      {t("gps.follow")}
                    </label>
                    <Button variant="outline" className="w-full" onClick={handleStop}>
                      <Square className="me-2 h-4 w-4" />
                      {t("gps.stop")}
                    </Button>
                  </>
                ) : (
                  <Button className="w-full" onClick={handleStart}>
                    <LocateFixed className="me-2 h-4 w-4" />
                    {t("gps.start")}
                  </Button>
                )}
              </div>

              <Separator />

              {/* Track log */}
              <div className="space-y-2">
                <Label>{t("gps.trackLog")}</Label>
                {recording !== "off" && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-md bg-muted p-2 text-sm tabular-nums">
                    <span>{t("gps.points", { count: fixCount })}</span>
                    <span>{formatDistance(stats.distanceM)}</span>
                    <span>{formatDuration(stats.durationS)}</span>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {recording === "off" && (
                    <Button size="sm" onClick={handleStartRecording}>
                      <Circle className="me-1 h-3.5 w-3.5 fill-red-500 text-red-500" />
                      {t("gps.record")}
                    </Button>
                  )}
                  {recording === "recording" && (
                    <Button size="sm" variant="outline" onClick={() => changeRecording("paused")}>
                      <Pause className="me-1 h-3.5 w-3.5" />
                      {t("gps.pause")}
                    </Button>
                  )}
                  {recording === "paused" && (
                    <Button size="sm" onClick={handleResumeRecording}>
                      <Play className="me-1 h-3.5 w-3.5" />
                      {t("gps.resume")}
                    </Button>
                  )}
                  {recording !== "off" && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canSaveTrack}
                        onClick={handleSaveTrack}
                      >
                        <Save className="me-1 h-3.5 w-3.5" />
                        {t("gps.saveTrack")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canSaveTrack}
                        onClick={() => void handleExportTrack("gpx")}
                      >
                        <Download className="me-1 h-3.5 w-3.5" />
                        {t("gps.exportGpx")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canSaveTrack}
                        onClick={() => void handleExportTrack("geojson")}
                      >
                        <Download className="me-1 h-3.5 w-3.5" />
                        {t("gps.exportGeojson")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={handleDiscardTrack}>
                        <Trash2 className="me-1 h-3.5 w-3.5" />
                        {t("gps.discard")}
                      </Button>
                    </>
                  )}
                </div>
              </div>

              <Separator />

              {/* Capture */}
              <div className="space-y-2">
                <Label>{t("gps.capture")}</Label>
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={!lastFix}
                  onClick={handleCapturePoint}
                >
                  <MapPin className="me-2 h-4 w-4" />
                  {t("gps.capturePoint")}
                </Button>
                {capturedCount > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t("gps.captured", { count: capturedCount })}
                  </p>
                )}
              </div>

              <Separator />

              {/* Settings */}
              <div className="space-y-2">
                <Label>{t("gps.settings")}</Label>
                <div className="grid grid-cols-3 gap-2">
                  <SettingField
                    id="gps-min-distance"
                    label={t("gps.minDistance")}
                    value={settings.minDistanceM}
                    onChange={(v) => updateSettings({ minDistanceM: v })}
                  />
                  <SettingField
                    id="gps-min-time"
                    label={t("gps.minTime")}
                    value={settings.minTimeS}
                    onChange={(v) => updateSettings({ minTimeS: v })}
                  />
                  <SettingField
                    id="gps-max-accuracy"
                    label={t("gps.maxAccuracy")}
                    value={settings.maxAccuracyM}
                    onChange={(v) => updateSettings({ maxAccuracyM: v })}
                  />
                </div>
                <p className="text-xs text-muted-foreground">{t("gps.settingsHint")}</p>
              </div>

              {(notice ?? error) && (
                <p
                  aria-live="polite"
                  className="rounded-md bg-muted p-2 text-sm text-muted-foreground"
                >
                  {notice ?? error}
                </p>
              )}
            </div>
          </ScrollArea>

          <div className="flex justify-end">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.close")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function FixReadout({ fix }: { fix: GpsFix | null }) {
  const { t } = useTranslation();
  if (!fix) {
    return (
      <p className="rounded-md bg-muted p-2 text-sm text-muted-foreground">
        {t("gps.waitingForFix")}
      </p>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-muted p-2 text-sm tabular-nums">
      <span>
        {fix.lng.toFixed(5)}, {fix.lat.toFixed(5)}
      </span>
      <span>±{Math.round(fix.accuracy)} m</span>
      {fix.altitude != null && <span>{Math.round(fix.altitude)} m ASL</span>}
      {fix.speed != null && <span>{formatSpeedKmh(fix.speed)} km/h</span>}
      {fix.heading != null && <span>{Math.round(fix.heading)}°</span>}
      <span className="text-muted-foreground">{new Date(fix.timestamp).toLocaleTimeString()}</span>
    </div>
  );
}

interface SettingFieldProps {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
}

function SettingField({ id, label, value, onChange }: SettingFieldProps) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        min={0}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) && n >= 0 ? n : 0);
        }}
      />
    </div>
  );
}

interface FloatingPanelProps {
  fix: GpsFix | null;
  recording: RecordingState;
  stats: { distanceM: number; durationS: number; pointCount: number };
  capturedCount: number;
  onCapture: () => void;
  onPause: () => void;
  onResume: () => void;
  onOpen: () => void;
}

/**
 * Compact live readout shown while GPS is on and the dialog is closed, so the
 * map stays fully visible in the field. Anchored to the trailing corner to
 * avoid the Field Collection quick-open button at bottom center.
 */
function FloatingPanel({
  fix,
  recording,
  stats,
  capturedCount,
  onCapture,
  onPause,
  onResume,
  onOpen,
}: FloatingPanelProps) {
  const { t } = useTranslation();
  return (
    <div className="fixed bottom-6 end-6 z-40 flex max-w-[95vw] flex-col gap-2 rounded-lg border bg-card p-3 shadow-xl">
      <div className="flex items-center gap-2 text-sm tabular-nums">
        <LocateFixed className="h-4 w-4 shrink-0 text-primary" />
        {fix ? (
          <span>
            {fix.lng.toFixed(5)}, {fix.lat.toFixed(5)} ±{Math.round(fix.accuracy)} m
          </span>
        ) : (
          <span className="text-muted-foreground">{t("gps.waitingForFix")}</span>
        )}
      </div>
      {recording !== "off" && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground tabular-nums">
          {recording === "recording" && (
            <Circle className="h-2.5 w-2.5 animate-pulse fill-red-500 text-red-500" />
          )}
          <span>{t("gps.points", { count: stats.pointCount })}</span>
          <span>{formatDistance(stats.distanceM)}</span>
          <span>{formatDuration(stats.durationS)}</span>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={!fix} onClick={onCapture}>
          <MapPin className="me-1 h-3.5 w-3.5" />
          {t("gps.capturePoint")}
        </Button>
        {recording === "recording" && (
          <Button size="sm" variant="outline" aria-label={t("gps.pause")} onClick={onPause}>
            <Pause className="h-3.5 w-3.5" />
          </Button>
        )}
        {recording === "paused" && (
          <Button size="sm" variant="outline" aria-label={t("gps.resume")} onClick={onResume}>
            <Play className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button size="sm" variant="ghost" aria-label={t("gps.openDialog")} onClick={onOpen}>
          <Maximize2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      {capturedCount > 0 && (
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {t("gps.captured", { count: capturedCount })}
        </p>
      )}
    </div>
  );
}
