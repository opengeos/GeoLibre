import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  useAppStore,
} from "@geolibre/core";
import { getLayerBounds, type MapController } from "@geolibre/map";
import {
  addArcGISLayer,
  type ArcGISLayerType,
  type ArcGISSourceType,
} from "@geolibre/plugins";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
} from "@geolibre/ui";
import type { FeatureCollection } from "geojson";
import {
  Columns3,
  Database,
  FileUp,
  Globe2,
  Map as MapIcon,
} from "lucide-react";
import {
  type FormEvent,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { openLocalDataFileWithFallback } from "../../lib/tauri-io";
import { createAppAPI } from "../../hooks/usePlugins";
import {
  parseDelimitedTextFields,
  parseDelimitedTextLayer,
} from "../../lib/delimited-text";
import { parseGpxLayer } from "../../lib/gpx";
import {
  createWfsGetFeatureUrl,
  fetchGeoJsonFeatureCollection,
} from "../../lib/layer-refresh";
import {
  mbtilesTileUrl,
  readMbtilesMetadata,
  registerMbtilesProtocol,
  type MbtilesMetadata,
} from "../../lib/mbtiles";
import {
  ensureMartinBinary,
  fetchMartinCatalog,
  fetchMartinTileJson,
  martinTileJsonUrl,
  startMartinServer,
  stopMartinServer,
  type MartinServerInfo,
  type MartinSourceSummary,
} from "../../lib/martin";
import { isTauri } from "../../lib/tauri-io";
import {
  createXyzTileUrlTemplate,
  registerXyzTileProtocol,
  resolveXyzTileUrlTemplate,
} from "../../lib/xyz-url";

export type AddDataKind =
  | "xyz"
  | "wms"
  | "wfs"
  | "wmts"
  | "gpx"
  | "delimited-text"
  | "mbtiles"
  | "arcgis"
  | "postgres";

interface AddDataDialogProps {
  kind: AddDataKind | null;
  mapControllerRef: RefObject<MapController | null>;
  onOpenChange: (open: boolean) => void;
}

type GpxMode = "url" | "file";
type GpxLayerKind = "waypoints" | "tracks" | "routes";
type DelimitedTextMode = "url" | "file";
type DelimitedTextDelimiter = "comma" | "tab" | "semicolon" | "pipe" | "custom";

const KIND_LABELS: Record<AddDataKind, string> = {
  xyz: "Add XYZ Layer",
  wms: "Add WMS Layer",
  wfs: "Add WFS Layer",
  wmts: "Add WMTS Layer",
  gpx: "Add GPX Layer",
  "delimited-text": "Add Delimited Text Layer",
  mbtiles: "Add MBTiles Layer",
  arcgis: "Add ArcGIS Layer",
  postgres: "Add PostgreSQL Layer",
};

const DEFAULT_XYZ_URL =
  "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}";
const DEFAULT_WMS_ENDPOINT =
  "https://imagery.nationalmap.gov/arcgis/services/USGSNAIPImagery/ImageServer/WMSServer";
const DEFAULT_WMS_LAYERS = "USGSNAIPImagery:FalseColorComposite";
const DEFAULT_WFS_ENDPOINT = "https://ahocevar.com/geoserver/wfs";
const DEFAULT_WFS_TYPE_NAME = "topp:states";
const DEFAULT_WMTS_URL =
  "https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/119/{z}/{y}/{x}";
const DEFAULT_GPX_URL =
  "https://data.source.coop/giswqs/opengeos/fells_loop.gpx";
const DEFAULT_DELIMITED_TEXT_URL =
  "https://data.source.coop/giswqs/opengeos/us_cities.csv";
const DEFAULT_DELIMITED_TEXT_LATITUDE_FIELD = "latitude";
const DEFAULT_DELIMITED_TEXT_LONGITUDE_FIELD = "longitude";
const DEFAULT_ARCGIS_FEATURE_URL =
  "https://services3.arcgis.com/GVgbJbqm8hXASVYi/arcgis/rest/services/USA_Major_Cities/FeatureServer/0";
const DEFAULT_ARCGIS_VECTOR_TILE_URL =
  "https://vectortileservices3.arcgis.com/GVgbJbqm8hXASVYi/arcgis/rest/services/Santa_Monica_parcels_VTL/VectorTileServer";
const DEFAULT_ARCGIS_URLS: Record<ArcGISLayerType, string> = {
  feature: DEFAULT_ARCGIS_FEATURE_URL,
  "vector-tile": DEFAULT_ARCGIS_VECTOR_TILE_URL,
};
// Keep in sync with GPX_PROXY_PATH in vite.config.ts (the dev proxy binds it there).
const GPX_PROXY_PATH = "/__geolibre_gpx_proxy";
const POSTGRES_CONNECTIONS_STORAGE_KEY =
  "geolibre.postgres.connectionStrings";
const MAX_SAVED_POSTGRES_CONNECTIONS = 10;
const DELIMITED_TEXT_DELIMITERS: Record<
  Exclude<DelimitedTextDelimiter, "custom">,
  string
> = {
  comma: ",",
  pipe: "|",
  semicolon: ";",
  tab: "\t",
};

function createLayerId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

function layerNameFromPath(path: string, fallback: string): string {
  return fileNameFromPath(path).replace(/\.[^.]+$/, "") || fallback;
}

function createBaseLayer(
  name: string,
  type: GeoLibreLayer["type"],
  source: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): GeoLibreLayer {
  return {
    id: createLayerId(),
    name,
    type,
    source,
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata,
  };
}

function appendQuery(
  endpoint: string,
  params: Array<[string, string]>,
): string {
  const separator = endpoint.includes("?")
    ? endpoint.endsWith("?") || endpoint.endsWith("&")
      ? ""
      : "&"
    : "?";
  const query = params
    .map(([key, value]) => {
      const encodedValue =
        value === "{bbox-epsg-3857}" ? value : encodeURIComponent(value);
      return `${encodeURIComponent(key)}=${encodedValue}`;
    })
    .join("&");
  return `${endpoint}${separator}${query}`;
}

function createWmsTileUrl(options: {
  endpoint: string;
  layers: string;
  styles: string;
  format: string;
  transparent: boolean;
  tileSize: number;
}): string {
  return appendQuery(options.endpoint, [
    ["SERVICE", "WMS"],
    ["REQUEST", "GetMap"],
    ["VERSION", "1.1.1"],
    ["LAYERS", options.layers],
    ["STYLES", options.styles],
    ["FORMAT", options.format],
    ["TRANSPARENT", options.transparent ? "TRUE" : "FALSE"],
    ["SRS", "EPSG:3857"],
    ["BBOX", "{bbox-epsg-3857}"],
    ["WIDTH", String(options.tileSize)],
    ["HEIGHT", String(options.tileSize)],
  ]);
}

function parseRequiredNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Enter a numeric ${label}.`);
  }
  return parsed;
}

function parseOptionalNumber(value: string, label: string): number | undefined {
  if (!value.trim()) return undefined;
  return parseRequiredNumber(value, label);
}

function readSavedPostgresConnections(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const value = window.localStorage.getItem(POSTGRES_CONNECTIONS_STORAGE_KEY);
    if (!value) return [];
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? uniquePostgresConnections(
          parsed.filter((item): item is string => typeof item === "string"),
        )
      : [];
  } catch {
    return [];
  }
}

function rememberPostgresConnection(connectionString: string): string[] {
  const trimmed = connectionString.trim();
  if (!trimmed || typeof window === "undefined") return [];

  const connections = uniquePostgresConnections([
    trimmed,
    ...readSavedPostgresConnections().filter((value) => value !== trimmed),
  ]).slice(0, MAX_SAVED_POSTGRES_CONNECTIONS);

  window.localStorage.setItem(
    POSTGRES_CONNECTIONS_STORAGE_KEY,
    JSON.stringify(connections),
  );
  return connections;
}

function uniquePostgresConnections(connections: string[]): string[] {
  return Array.from(new Set(connections));
}

function savedPostgresConnectionLabel(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.password) url.password = "****";
    return url.toString();
  } catch {
    return connectionString
      .replace(/(:\/\/[^:\s/@]+:)[^@\s]+@/, "$1****@")
      .replace(/(password\s*=\s*)('[^']*'|[^\s]+)/i, "$1****");
  }
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

function isViteDevServer(): boolean {
  return Boolean(
    (
      import.meta as ImportMeta & {
        env?: { DEV?: boolean };
      }
    ).env?.DEV,
  );
}

function proxyGpxRequestUrl(url: string): string {
  return isViteDevServer()
    ? `${GPX_PROXY_PATH}?url=${encodeURIComponent(url)}`
    : url;
}

function resolveDelimitedTextDelimiter(
  delimiter: DelimitedTextDelimiter,
  customDelimiter: string,
): string {
  if (delimiter !== "custom") return DELIMITED_TEXT_DELIMITERS[delimiter];
  return customDelimiter;
}

function inferDelimitedTextField(
  fields: string[],
  currentField: string,
  candidates: string[],
): string {
  const current = currentField.trim().toLowerCase();
  const currentMatch = fields.find(
    (field) => field.trim().toLowerCase() === current,
  );
  if (currentMatch) return currentMatch;

  for (const candidate of candidates) {
    const match = fields.find(
      (field) => field.trim().toLowerCase() === candidate,
    );
    if (match) return match;
  }

  return fields[0] ?? currentField;
}

export function AddDataDialog({
  kind,
  mapControllerRef,
  onOpenChange,
}: AddDataDialogProps) {
  const open = kind !== null;
  const addLayer = useAppStore((s) => s.addLayer);
  const title = kind ? KIND_LABELS[kind] : "Add Data";

  const [layerName, setLayerName] = useState("");
  const [beforeLayerId, setBeforeLayerId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [xyzUrl, setXyzUrl] = useState(DEFAULT_XYZ_URL);
  const [xyzTileSize, setXyzTileSize] = useState("256");
  const [xyzShortUrl, setXyzShortUrl] = useState(false);

  const [wmsEndpoint, setWmsEndpoint] = useState(DEFAULT_WMS_ENDPOINT);
  const [wmsLayers, setWmsLayers] = useState(DEFAULT_WMS_LAYERS);
  const [wmsStyles, setWmsStyles] = useState("");
  const [wmsFormat, setWmsFormat] = useState("image/png");
  const [wmsTransparent, setWmsTransparent] = useState(true);
  const [wmsTileSize, setWmsTileSize] = useState("256");
  const [wfsEndpoint, setWfsEndpoint] = useState(DEFAULT_WFS_ENDPOINT);
  const [wfsTypeName, setWfsTypeName] = useState(DEFAULT_WFS_TYPE_NAME);
  const [wfsVersion, setWfsVersion] = useState("2.0.0");
  const [wfsOutputFormat, setWfsOutputFormat] = useState("application/json");
  const [wfsSrsName, setWfsSrsName] = useState("EPSG:4326");
  const [wfsMaxFeatures, setWfsMaxFeatures] = useState("1000");
  const [wmtsUrl, setWmtsUrl] = useState(DEFAULT_WMTS_URL);
  const [wmtsTileSize, setWmtsTileSize] = useState("256");

  const [gpxMode, setGpxMode] = useState<GpxMode>("url");
  const [gpxUrl, setGpxUrl] = useState(DEFAULT_GPX_URL);
  const [selectedGpx, setSelectedGpx] = useState<{
    path: string;
    text: string;
  } | null>(null);
  const [selectedGpxLayerKinds, setSelectedGpxLayerKinds] = useState<
    Record<GpxLayerKind, boolean>
  >({
    routes: true,
    tracks: true,
    waypoints: true,
  });
  const [delimitedTextMode, setDelimitedTextMode] =
    useState<DelimitedTextMode>("url");
  const [delimitedTextUrl, setDelimitedTextUrl] = useState(
    DEFAULT_DELIMITED_TEXT_URL,
  );
  const [delimitedTextDelimiter, setDelimitedTextDelimiter] =
    useState<DelimitedTextDelimiter>("comma");
  const [delimitedTextCustomDelimiter, setDelimitedTextCustomDelimiter] =
    useState("");
  const [delimitedTextLatitudeField, setDelimitedTextLatitudeField] =
    useState(DEFAULT_DELIMITED_TEXT_LATITUDE_FIELD);
  const [delimitedTextLongitudeField, setDelimitedTextLongitudeField] =
    useState(DEFAULT_DELIMITED_TEXT_LONGITUDE_FIELD);
  const [delimitedTextFields, setDelimitedTextFields] = useState<string[]>([]);
  const [delimitedTextColumnsStatus, setDelimitedTextColumnsStatus] = useState<
    string | null
  >(null);
  const [isRetrievingDelimitedTextColumns, setIsRetrievingDelimitedTextColumns] =
    useState(false);
  const [selectedDelimitedText, setSelectedDelimitedText] = useState<{
    path: string;
    text: string;
  } | null>(null);

  const [selectedMbtiles, setSelectedMbtiles] = useState<{
    metadata: MbtilesMetadata;
    path: string;
  } | null>(null);
  const [mbtilesSourceLayers, setMbtilesSourceLayers] = useState("");
  const [arcgisLayerType, setArcgisLayerType] =
    useState<ArcGISLayerType>("feature");
  const [arcgisSourceType, setArcgisSourceType] =
    useState<ArcGISSourceType>("url");
  const [arcgisUrl, setArcgisUrl] = useState(DEFAULT_ARCGIS_FEATURE_URL);
  const [arcgisItemId, setArcgisItemId] = useState("");
  const [arcgisPortalUrl, setArcgisPortalUrl] = useState("");
  const [arcgisAccessToken, setArcgisAccessToken] = useState("");
  const [postgresConnectionString, setPostgresConnectionString] = useState("");
  const [savedPostgresConnections, setSavedPostgresConnections] = useState<
    string[]
  >(() => readSavedPostgresConnections());
  const [postgresDefaultSrid, setPostgresDefaultSrid] = useState("");
  const [martinServer, setMartinServer] = useState<MartinServerInfo | null>(
    null,
  );
  const [martinSources, setMartinSources] = useState<MartinSourceSummary[]>([]);
  const [selectedMartinSourceId, setSelectedMartinSourceId] = useState("");
  const [martinStatus, setMartinStatus] = useState<string | null>(null);
  const martinLayerAddedRef = useRef(false);

  useEffect(() => {
    if (!kind) return;
    if (kind === "postgres" && !martinServer) martinLayerAddedRef.current = false;
    setError(null);
    setIsSubmitting(false);
    setLayerName(
      {
        xyz: "XYZ Layer",
        wms: "WMS Layer",
        wfs: "WFS Layer",
        wmts: "WMTS Layer",
        gpx: "GPX Layer",
        "delimited-text": "Delimited Text Layer",
        mbtiles: "MBTiles Layer",
        arcgis: "ArcGIS Layer",
        postgres: "PostgreSQL Layer",
      }[kind],
    );
    setBeforeLayerId("");
    setXyzUrl(DEFAULT_XYZ_URL);
    setXyzTileSize("256");
    setXyzShortUrl(false);
    setWmsEndpoint(DEFAULT_WMS_ENDPOINT);
    setWmsLayers(DEFAULT_WMS_LAYERS);
    setWmsStyles("");
    setWmsFormat("image/png");
    setWmsTransparent(true);
    setWmsTileSize("256");
    setWfsEndpoint(DEFAULT_WFS_ENDPOINT);
    setWfsTypeName(DEFAULT_WFS_TYPE_NAME);
    setWfsVersion("2.0.0");
    setWfsOutputFormat("application/json");
    setWfsSrsName("EPSG:4326");
    setWfsMaxFeatures("1000");
    setWmtsUrl(DEFAULT_WMTS_URL);
    setWmtsTileSize("256");
    setGpxMode("url");
    setGpxUrl(DEFAULT_GPX_URL);
    setSelectedGpx(null);
    setSelectedGpxLayerKinds({
      routes: true,
      tracks: true,
      waypoints: true,
    });
    setDelimitedTextMode("url");
    setDelimitedTextUrl(DEFAULT_DELIMITED_TEXT_URL);
    setDelimitedTextDelimiter("comma");
    setDelimitedTextCustomDelimiter("");
    setDelimitedTextLatitudeField(DEFAULT_DELIMITED_TEXT_LATITUDE_FIELD);
    setDelimitedTextLongitudeField(DEFAULT_DELIMITED_TEXT_LONGITUDE_FIELD);
    setDelimitedTextFields([]);
    setDelimitedTextColumnsStatus(null);
    setIsRetrievingDelimitedTextColumns(false);
    setSelectedDelimitedText(null);
    setSelectedMbtiles(null);
    setMbtilesSourceLayers("");
    setArcgisLayerType("feature");
    setArcgisSourceType("url");
    setArcgisUrl(DEFAULT_ARCGIS_FEATURE_URL);
    setArcgisItemId("");
    setArcgisPortalUrl("");
    setArcgisAccessToken("");
    const savedConnections = readSavedPostgresConnections();
    setSavedPostgresConnections(savedConnections);
    setPostgresConnectionString(
      kind === "postgres" ? (savedConnections[0] ?? "") : "",
    );
    setPostgresDefaultSrid("");
    if (!martinLayerAddedRef.current) {
      setMartinServer(null);
      setMartinSources([]);
      setSelectedMartinSourceId("");
      setMartinStatus(null);
    }
  }, [kind]);

  const description = useMemo(() => {
    if (kind === "xyz") {
      return "Add a raster tile template using x, y, and z placeholders.";
    }
    if (kind === "wms") {
      return "Add a WMS GetMap service as a tiled raster layer.";
    }
    if (kind === "wfs") {
      return "Add WFS features by requesting GeoJSON from a GetFeature service.";
    }
    if (kind === "wmts") {
      return "Add a WMTS tile URL template as a raster layer.";
    }
    if (kind === "gpx") {
      return "Add GPX waypoints, routes, and tracks as one or more vector layers.";
    }
    if (kind === "delimited-text") {
      return "Add a delimited text file or URL as a point layer using longitude and latitude fields.";
    }
    if (kind === "mbtiles") {
      return "Add a local MBTiles file as a raster or vector tile layer.";
    }
    if (kind === "arcgis") {
      return "Add an ArcGIS FeatureServer layer, VectorTileServer layer, or portal item.";
    }
    if (kind === "postgres") {
      return "Start Martin locally, discover PostGIS sources, and add a source as vector tiles.";
    }
    return "";
  }, [kind]);

  const stopTransientMartinServer = () => {
    if (!martinServer || martinLayerAddedRef.current) return;
    void stopMartinServer();
    setMartinServer(null);
    setMartinSources([]);
    setSelectedMartinSourceId("");
    setMartinStatus(null);
  };

  const closeDialog = () => {
    stopTransientMartinServer();
    onOpenChange(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && isSubmitting) return;
    if (!next) stopTransientMartinServer();
    onOpenChange(next);
  };

  const handleGpxModeChange = (mode: GpxMode) => {
    setGpxMode(mode);
    setSelectedGpx(null);
    if (mode === "url" && !gpxUrl.trim()) {
      setGpxUrl(DEFAULT_GPX_URL);
    }
  };

  const setGpxLayerKindSelected = (
    layerKind: GpxLayerKind,
    selected: boolean,
  ) => {
    setSelectedGpxLayerKinds((current) => ({
      ...current,
      [layerKind]: selected,
    }));
  };

  const resetDelimitedTextColumns = () => {
    setDelimitedTextFields([]);
    setDelimitedTextColumnsStatus(null);
  };

  const handleDelimitedTextModeChange = (mode: DelimitedTextMode) => {
    setDelimitedTextMode(mode);
    setSelectedDelimitedText(null);
    resetDelimitedTextColumns();
    if (mode === "url" && !delimitedTextUrl.trim()) {
      setDelimitedTextUrl(DEFAULT_DELIMITED_TEXT_URL);
    }
  };

  const readDelimitedTextSource = async (): Promise<{
    sourcePath: string;
    text: string;
  }> => {
    if (delimitedTextMode === "file") {
      if (!selectedDelimitedText) {
        throw new Error("Choose a delimited text file.");
      }
      return {
        sourcePath: selectedDelimitedText.path,
        text: selectedDelimitedText.text,
      };
    }

    const sourcePath = delimitedTextUrl.trim();
    if (!sourcePath) throw new Error("Enter a delimited text URL.");

    const response = await fetch(sourcePath);
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    return {
      sourcePath,
      text: await response.text(),
    };
  };

  const readGpxSource = async (): Promise<{
    sourcePath: string;
    text: string;
  }> => {
    if (gpxMode === "file") {
      if (!selectedGpx) throw new Error("Choose a GPX file.");
      return {
        sourcePath: selectedGpx.path,
        text: selectedGpx.text,
      };
    }

    const sourcePath = gpxUrl.trim();
    if (!sourcePath) throw new Error("Enter a GPX URL.");

    const response = await fetch(proxyGpxRequestUrl(sourcePath));
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    return {
      sourcePath,
      text: await response.text(),
    };
  };

  const handleRetrieveDelimitedTextColumns = async () => {
    setError(null);
    setDelimitedTextColumnsStatus(null);
    setIsRetrievingDelimitedTextColumns(true);

    try {
      const delimiter = resolveDelimitedTextDelimiter(
        delimitedTextDelimiter,
        delimitedTextCustomDelimiter,
      );
      const { text } = await readDelimitedTextSource();
      const fields = parseDelimitedTextFields(text, delimiter);
      setDelimitedTextFields(fields);
      setDelimitedTextLongitudeField((current) =>
        inferDelimitedTextField(fields, current, [
          "longitude",
          "lon",
          "lng",
          "long",
          "x",
          "xcoord",
          "x_coord",
        ]),
      );
      setDelimitedTextLatitudeField((current) =>
        inferDelimitedTextField(fields, current, [
          "latitude",
          "lat",
          "y",
          "ycoord",
          "y_coord",
        ]),
      );
      setDelimitedTextColumnsStatus(
        `Retrieved ${fields.length} column${fields.length === 1 ? "" : "s"}.`,
      );
    } catch (err) {
      setError(errorMessage(err, "Could not retrieve column names."));
      setDelimitedTextFields([]);
    } finally {
      setIsRetrievingDelimitedTextColumns(false);
    }
  };

  const beforeLayer = beforeLayerId.trim() || null;

  const handleArcgisLayerTypeChange = (nextLayerType: ArcGISLayerType) => {
    const currentUrl = arcgisUrl.trim();
    setArcgisLayerType(nextLayerType);
    if (
      !currentUrl ||
      Object.values(DEFAULT_ARCGIS_URLS).includes(currentUrl)
    ) {
      setArcgisUrl(DEFAULT_ARCGIS_URLS[nextLayerType]);
    }
  };

  const addAndClose = (
    layer: GeoLibreLayer,
    options: { fit?: boolean } = {},
  ) => {
    addLayer(layer, beforeLayer);
    if (options.fit) mapControllerRef.current?.fitLayer(layer);
    closeDialog();
  };

  const handleConnectPostgres = async () => {
    setError(null);
    setMartinStatus(null);
    setIsSubmitting(true);
    setMartinSources([]);
    setSelectedMartinSourceId("");

    try {
      if (!isTauri()) {
        throw new Error("PostgreSQL layers require GeoLibre Desktop.");
      }
      if (!postgresConnectionString.trim()) {
        throw new Error("Enter a PostgreSQL connection string.");
      }
      const connectionString = postgresConnectionString.trim();

      setMartinStatus("Checking Martin binary...");
      const binary = await ensureMartinBinary();
      setMartinStatus(
        binary.downloaded
          ? "Martin downloaded. Starting local server..."
          : "Starting local Martin server...",
      );
      const server = await startMartinServer({
        connectionString,
        defaultSrid: postgresDefaultSrid,
      });
      setSavedPostgresConnections(
        rememberPostgresConnection(connectionString),
      );
      setMartinServer(server);
      setMartinStatus("Reading Martin catalog...");

      const sources = await fetchMartinCatalog(server);
      setMartinSources(sources);
      setSelectedMartinSourceId(sources[0]?.id ?? "");
      setMartinStatus(
        sources.length > 0
          ? `Found ${sources.length} source${sources.length === 1 ? "" : "s"}.`
          : "Martin is running, but no compatible PostGIS sources were found.",
      );
    } catch (err) {
      setMartinServer(null);
      setError(errorMessage(err, "Could not connect to PostgreSQL."));
      setMartinStatus(null);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStopMartin = async () => {
    setError(null);
    setIsSubmitting(true);
    try {
      await stopMartinServer();
      martinLayerAddedRef.current = false;
      setMartinServer(null);
      setMartinSources([]);
      setSelectedMartinSourceId("");
      setMartinStatus("Martin stopped.");
    } catch (err) {
      setError(errorMessage(err, "Could not stop Martin."));
    } finally {
      setIsSubmitting(false);
    }
  };

  const addMartinSource = async (sourceId: string) => {
    if (!martinServer) throw new Error("Connect to PostgreSQL first.");
    const tilejson = await fetchMartinTileJson(martinServer, sourceId);
    const vectorLayers = tilejson.vector_layers ?? tilejson.vectorLayers ?? [];
    const sourceLayer = vectorLayers[0]?.id;
    if (!sourceLayer) {
      throw new Error("The selected Martin source has no vector layers.");
    }

    const source = martinSources.find((candidate) => candidate.id === sourceId);
    const tilejsonUrl = martinTileJsonUrl(martinServer, sourceId);
    martinLayerAddedRef.current = true;
    addAndClose(
      createBaseLayer(
        layerName.trim() || tilejson.name || source?.name || sourceId,
        "vector-tiles",
        {
          type: "vector",
          url: tilejsonUrl,
          sourceLayer,
          sourceLayers: vectorLayers.map((vectorLayer) => vectorLayer.id),
          bounds: tilejson.bounds,
          minzoom: tilejson.minzoom,
          maxzoom: tilejson.maxzoom,
        },
        {
          bounds: tilejson.bounds,
          center: tilejson.center,
          maxzoom: tilejson.maxzoom,
          minzoom: tilejson.minzoom,
          martinPort: martinServer.port,
          martinSourceId: sourceId,
          sourceKind: "martin-postgis",
          sourceLayers: vectorLayers.map((vectorLayer) => vectorLayer.id),
          tilejsonUrl,
        },
      ),
      { fit: true },
    );
  };


  const handleChooseDelimitedText = async () => {
    setError(null);
    try {
      const result = await openLocalDataFileWithFallback({
        filters: [
          {
            name: "Delimited text",
            extensions: ["csv", "tsv", "txt", "dat"],
          },
        ],
        accept: ".csv,.tsv,.txt,.dat",
        readText: true,
      });
      if (!result) return;
      if (!result.text) throw new Error("Delimited text file data is missing.");
      setSelectedDelimitedText({
        path: result.path,
        text: result.text,
      });
      resetDelimitedTextColumns();
      setLayerName((current) =>
        current.trim() && current !== "Delimited Text Layer"
          ? current
          : layerNameFromPath(result.path, "Delimited Text Layer"),
      );
    } catch (err) {
      setError(errorMessage(err, "Could not read delimited text file."));
    }
  };

  const handleChooseGpx = async () => {
    setError(null);
    try {
      const result = await openLocalDataFileWithFallback({
        filters: [
          {
            name: "GPX",
            extensions: ["gpx"],
          },
        ],
        accept: ".gpx",
        readText: true,
      });
      if (!result) return;
      if (!result.text) throw new Error("GPX file data is missing.");
      setSelectedGpx({
        path: result.path,
        text: result.text,
      });
      setLayerName((current) =>
        current.trim() && current !== "GPX Layer"
          ? current
          : layerNameFromPath(result.path, "GPX Layer"),
      );
    } catch (err) {
      setError(errorMessage(err, "Could not read GPX file."));
    }
  };

  const handleChooseMbtilesFile = async () => {
    setError(null);
    try {
      const result = await openLocalDataFileWithFallback({
        filters: [
          {
            name: "MBTiles",
            extensions: ["mbtiles"],
          },
        ],
        accept: ".mbtiles",
      });
      if (!result) return;
      const metadata = await readMbtilesMetadata(result.path);
      setSelectedMbtiles({ metadata, path: result.path });
      setMbtilesSourceLayers(metadata.sourceLayers.join(", "));
      setLayerName((current) =>
        current.trim() && current !== "MBTiles Layer"
          ? current
          : metadata.name || layerNameFromPath(result.path, "MBTiles Layer"),
      );
    } catch (err) {
      setError(errorMessage(err, "Could not read MBTiles file."));
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!kind) return;
    setError(null);
    setIsSubmitting(true);

    try {
      const name = layerName.trim() || KIND_LABELS[kind].replace("Add ", "");

      if (kind === "xyz") {
        if (!xyzUrl.trim()) throw new Error("Enter an XYZ tile URL template.");
        if (xyzShortUrl) registerXyzTileProtocol();
        const tileUrl = xyzShortUrl
          ? await resolveXyzTileUrlTemplate(xyzUrl)
          : createXyzTileUrlTemplate(xyzUrl);
        addAndClose(
          createBaseLayer(
            name,
            "xyz",
            {
              type: "raster",
              tiles: [tileUrl.renderUrl],
              tileSize: Number(xyzTileSize) || 256,
              url: tileUrl.originalUrl,
            },
            {
              originalUrl: xyzShortUrl ? tileUrl.originalUrl : undefined,
              resolvedUrl: tileUrl.redirected ? tileUrl.url : undefined,
              sourceKind: "xyz-url",
            },
          ),
        );
        return;
      }

      if (kind === "wms") {
        if (!wmsEndpoint.trim()) throw new Error("Enter a WMS service URL.");
        if (!wmsLayers.trim()) {
          throw new Error("Enter one or more WMS layer names.");
        }
        const tileSize = Number(wmsTileSize) || 256;
        const tileUrl = createWmsTileUrl({
          endpoint: wmsEndpoint.trim(),
          layers: wmsLayers.trim(),
          styles: wmsStyles.trim(),
          format: wmsFormat,
          transparent: wmsTransparent,
          tileSize,
        });
        addAndClose(
          createBaseLayer(
            name,
            "wms",
            {
              type: "raster",
              tiles: [tileUrl],
              tileSize,
              url: wmsEndpoint.trim(),
              layers: wmsLayers.trim(),
              styles: wmsStyles.trim(),
              format: wmsFormat,
              transparent: wmsTransparent,
            },
            { service: "wms" },
          ),
        );
        return;
      }

      if (kind === "wfs") {
        if (!wfsEndpoint.trim()) throw new Error("Enter a WFS service URL.");
        if (!wfsTypeName.trim()) {
          throw new Error("Enter a WFS feature type name.");
        }
        if (!wfsOutputFormat.trim()) {
          throw new Error("Enter a WFS output format.");
        }
        parseOptionalNumber(wfsMaxFeatures, "max features");

        const featureUrl = createWfsGetFeatureUrl({
          endpoint: wfsEndpoint.trim(),
          typeName: wfsTypeName.trim(),
          version: wfsVersion,
          outputFormat: wfsOutputFormat.trim(),
          srsName: wfsSrsName.trim(),
          maxFeatures: wfsMaxFeatures.trim() || undefined,
        });
        const data = await fetchGeoJsonFeatureCollection(featureUrl, {
          useWfsProxy: true,
        });
        addAndClose(
          {
            ...createBaseLayer(
              name,
              "geojson",
              {
                type: "geojson",
                url: featureUrl,
                service: "wfs",
                typeName: wfsTypeName.trim(),
                version: wfsVersion,
                outputFormat: wfsOutputFormat.trim(),
                srsName: wfsSrsName.trim() || undefined,
              },
              {
                featureCount: data.features.length,
                service: "wfs",
                sourceKind: "wfs-getfeature",
                typeName: wfsTypeName.trim(),
              },
            ),
            geojson: data,
            sourcePath: featureUrl,
          },
          { fit: true },
        );
        return;
      }

      if (kind === "wmts") {
        if (!wmtsUrl.trim()) {
          throw new Error("Enter a WMTS tile URL template.");
        }
        addAndClose(
          createBaseLayer(
            name,
            "wmts",
            {
              type: "raster",
              tiles: [wmtsUrl.trim()],
              tileSize: Number(wmtsTileSize) || 256,
              url: wmtsUrl.trim(),
            },
            { service: "wmts" },
          ),
        );
        return;
      }

      if (kind === "gpx") {
        if (!hasSelectedGpxLayerKind) {
          throw new Error("Select at least one GPX layer type.");
        }

        const { sourcePath, text } = await readGpxSource();
        const result = parseGpxLayer(text);
        const gpxLayerGroups: Array<{
          featureCollection: FeatureCollection;
          kind: GpxLayerKind;
          label: string;
        }> = [
          {
            featureCollection: result.waypoints,
            kind: "waypoints",
            label: "Waypoints",
          },
          {
            featureCollection: result.tracks,
            kind: "tracks",
            label: "Tracks",
          },
          {
            featureCollection: result.routes,
            kind: "routes",
            label: "Routes",
          },
        ];
        const layers = gpxLayerGroups
          .filter(
            (group) =>
              selectedGpxLayerKinds[group.kind] &&
              group.featureCollection.features.length > 0,
          )
          .map((group) => ({
            ...createBaseLayer(
              `${name} ${group.label}`,
              "geojson",
              {
                type: "geojson",
                url: sourcePath,
              },
              {
                featureCount: group.featureCollection.features.length,
                gpxLayerKind: group.kind,
                routeCount: result.routeCount,
                sourceKind: "gpx",
                trackCount: result.trackCount,
                waypointCount: result.waypointCount,
              },
            ),
            geojson: group.featureCollection,
            sourcePath,
          }));

        if (layers.length === 0) {
          throw new Error("The selected GPX layer types were not found.");
        }

        for (const layer of layers) {
          addLayer(layer, beforeLayer);
        }
        const combinedBounds = layers.reduce<
          [number, number, number, number] | null
        >((merged, layer) => {
          const bounds = getLayerBounds(layer);
          if (!bounds) return merged;
          if (!merged) return bounds;
          return [
            Math.min(merged[0], bounds[0]),
            Math.min(merged[1], bounds[1]),
            Math.max(merged[2], bounds[2]),
            Math.max(merged[3], bounds[3]),
          ];
        }, null);
        if (combinedBounds) {
          mapControllerRef.current?.fitBounds(combinedBounds);
        } else {
          mapControllerRef.current?.fitLayer(layers[0]);
        }
        closeDialog();
        return;
      }

      if (kind === "delimited-text") {
        const delimiter = resolveDelimitedTextDelimiter(
          delimitedTextDelimiter,
          delimitedTextCustomDelimiter,
        );
        const { sourcePath, text } = await readDelimitedTextSource();
        if (!text) throw new Error("Delimited text data is missing.");

        const result = parseDelimitedTextLayer(text, {
          delimiter,
          latitudeField: delimitedTextLatitudeField,
          longitudeField: delimitedTextLongitudeField,
        });
        addAndClose(
          {
            ...createBaseLayer(
              name,
              "geojson",
              {
                type: "geojson",
                url: sourcePath,
              },
              {
                delimiter,
                featureCount: result.data.features.length,
                fields: result.fields,
                latitudeField: delimitedTextLatitudeField.trim(),
                longitudeField: delimitedTextLongitudeField.trim(),
                skippedRows: result.skippedRows,
                sourceKind: "delimited-text",
                totalRows: result.totalRows,
              },
            ),
            geojson: result.data,
            sourcePath,
          },
          { fit: true },
        );
        return;
      }

      if (kind === "mbtiles") {
        if (!selectedMbtiles) throw new Error("Choose an MBTiles file.");
        registerMbtilesProtocol();

        const { metadata, path } = selectedMbtiles;
        const sourceLayers = mbtilesSourceLayers
          .split(",")
          .map((sourceLayer) => sourceLayer.trim())
          .filter(Boolean);
        if (metadata.tileType === "vector" && sourceLayers.length === 0) {
          throw new Error("Enter at least one vector source layer.");
        }

        const minzoom = metadata.minZoom ?? undefined;
        const maxzoom = metadata.maxZoom ?? undefined;
        addAndClose(
          createBaseLayer(
            name,
            "mbtiles",
            {
              bounds: metadata.bounds ?? undefined,
              maxzoom,
              minzoom,
              sourceLayers,
              tileSize: 256,
              tiles: [mbtilesTileUrl(path)],
              type: metadata.tileType,
            },
            {
              bounds: metadata.bounds,
              center: metadata.center,
              format: metadata.format,
              maxzoom,
              minzoom,
              scheme: metadata.scheme,
              sourceKind: "mbtiles-file",
              sourceLayers,
              tileType: metadata.tileType,
            },
          ),
        );
        return;
      }

      if (kind === "arcgis") {
        await addArcGISLayer(createAppAPI(mapControllerRef), {
          beforeLayerId: beforeLayer,
          itemId: arcgisItemId.trim() || undefined,
          layerType: arcgisLayerType,
          name,
          portalUrl: arcgisPortalUrl.trim() || undefined,
          sourceType: arcgisSourceType,
          token: arcgisAccessToken.trim() || undefined,
          url: arcgisUrl.trim() || undefined,
        });
        closeDialog();
        return;
      }

      if (kind === "postgres") {
        if (!martinServer) {
          throw new Error("Connect to PostgreSQL first.");
        }
        if (!selectedMartinSourceId) {
          throw new Error("Select a Martin source to add.");
        }
        await addMartinSource(selectedMartinSourceId);
        return;
      }
    } catch (err) {
      setError(errorMessage(err, "Could not add layer."));
    } finally {
      setIsSubmitting(false);
    }
  };

  const delimitedTextFieldOptions = useMemo(
    () =>
      Array.from(
        new Set(
          [
            ...delimitedTextFields,
            delimitedTextLongitudeField,
            delimitedTextLatitudeField,
          ].filter((field) => field.trim()),
        ),
      ),
    [
      delimitedTextFields,
      delimitedTextLatitudeField,
      delimitedTextLongitudeField,
    ],
  );

  const missingCustomDelimiter =
    delimitedTextDelimiter === "custom" &&
    !delimitedTextCustomDelimiter.trim();
  const hasSelectedGpxLayerKind = Object.values(selectedGpxLayerKinds).some(
    Boolean,
  );

  const addLayerDisabled =
    isSubmitting ||
    isRetrievingDelimitedTextColumns ||
    (kind === "gpx" && !hasSelectedGpxLayerKind) ||
    (kind === "delimited-text" && missingCustomDelimiter) ||
    (kind === "postgres" && (!martinServer || !selectedMartinSourceId));

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Database className="h-4 w-4" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="add-data-layer-name">Layer name</Label>
            <Input
              id="add-data-layer-name"
              value={layerName}
              onChange={(event) => setLayerName(event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="add-data-before-id">Before Id</Label>
            <Input
              id="add-data-before-id"
              placeholder="Optional layer id"
              value={beforeLayerId}
              onChange={(event) => setBeforeLayerId(event.target.value)}
            />
          </div>

          {kind === "xyz" && (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
                <div className="space-y-1.5">
                  <Label htmlFor="xyz-url">Tile URL template</Label>
                  <Input
                    id="xyz-url"
                    placeholder={
                      xyzShortUrl
                        ? "https://go.example.com/layer"
                        : "https://example.com/{z}/{x}/{y}.png"
                    }
                    value={xyzUrl}
                    onChange={(event) => setXyzUrl(event.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="xyz-tile-size">Tile size</Label>
                  <Input
                    id="xyz-tile-size"
                    inputMode="numeric"
                    value={xyzTileSize}
                    onChange={(event) => setXyzTileSize(event.target.value)}
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={xyzShortUrl}
                  onChange={(event) => setXyzShortUrl(event.target.checked)}
                />
                Short URL
              </label>
            </div>
          )}

          {kind === "wms" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="wms-endpoint">Service URL</Label>
                <Input
                  id="wms-endpoint"
                  placeholder="https://example.com/geoserver/wms"
                  value={wmsEndpoint}
                  onChange={(event) => setWmsEndpoint(event.target.value)}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="wms-layers">Layers</Label>
                  <Input
                    id="wms-layers"
                    placeholder="workspace:layer"
                    value={wmsLayers}
                    onChange={(event) => setWmsLayers(event.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wms-styles">Styles</Label>
                  <Input
                    id="wms-styles"
                    value={wmsStyles}
                    onChange={(event) => setWmsStyles(event.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wms-format">Format</Label>
                  <Select
                    id="wms-format"
                    value={wmsFormat}
                    onChange={(event) => setWmsFormat(event.target.value)}
                  >
                    <option value="image/png">PNG</option>
                    <option value="image/jpeg">JPEG</option>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wms-tile-size">Tile size</Label>
                  <Input
                    id="wms-tile-size"
                    inputMode="numeric"
                    value={wmsTileSize}
                    onChange={(event) => setWmsTileSize(event.target.value)}
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={wmsTransparent}
                  onChange={(event) => setWmsTransparent(event.target.checked)}
                />
                Transparent background
              </label>
            </div>
          )}

          {kind === "wfs" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="wfs-endpoint">Service URL</Label>
                <Input
                  id="wfs-endpoint"
                  placeholder="https://example.com/geoserver/wfs"
                  value={wfsEndpoint}
                  onChange={(event) => setWfsEndpoint(event.target.value)}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="wfs-type-name">Feature type</Label>
                  <Input
                    id="wfs-type-name"
                    placeholder="workspace:layer"
                    value={wfsTypeName}
                    onChange={(event) => setWfsTypeName(event.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wfs-version">Version</Label>
                  <Select
                    id="wfs-version"
                    value={wfsVersion}
                    onChange={(event) => setWfsVersion(event.target.value)}
                  >
                    <option value="2.0.0">2.0.0</option>
                    <option value="1.1.0">1.1.0</option>
                    <option value="1.0.0">1.0.0</option>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wfs-output-format">Output format</Label>
                  <Input
                    id="wfs-output-format"
                    value={wfsOutputFormat}
                    onChange={(event) =>
                      setWfsOutputFormat(event.target.value)
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wfs-srs-name">SRS name</Label>
                  <Input
                    id="wfs-srs-name"
                    placeholder="Optional"
                    value={wfsSrsName}
                    onChange={(event) => setWfsSrsName(event.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wfs-max-features">Max features</Label>
                  <Input
                    id="wfs-max-features"
                    inputMode="numeric"
                    placeholder="Optional"
                    value={wfsMaxFeatures}
                    onChange={(event) => setWfsMaxFeatures(event.target.value)}
                  />
                </div>
              </div>
            </div>
          )}

          {kind === "wmts" && (
            <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
              <div className="space-y-1.5">
                <Label htmlFor="wmts-url">Tile URL template</Label>
                <Input
                  id="wmts-url"
                  placeholder="https://example.com/wmts/{z}/{y}/{x}.png"
                  value={wmtsUrl}
                  onChange={(event) => setWmtsUrl(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wmts-tile-size">Tile size</Label>
                <Input
                  id="wmts-tile-size"
                  inputMode="numeric"
                  value={wmtsTileSize}
                  onChange={(event) => setWmtsTileSize(event.target.value)}
                />
              </div>
            </div>
          )}

          {kind === "gpx" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="gpx-mode">Source type</Label>
                <Select
                  id="gpx-mode"
                  value={gpxMode}
                  onChange={(event) =>
                    handleGpxModeChange(event.target.value as GpxMode)
                  }
                >
                  <option value="url">GPX URL</option>
                  <option value="file">GPX file</option>
                </Select>
              </div>

              {gpxMode === "file" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleChooseGpx}
                  >
                    <FileUp className="mr-2 h-3.5 w-3.5" />
                    Choose file
                  </Button>
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {selectedGpx
                      ? fileNameFromPath(selectedGpx.path)
                      : "No file selected"}
                  </span>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor="gpx-url">GPX URL</Label>
                  <Input
                    id="gpx-url"
                    placeholder="https://example.com/route.gpx"
                    value={gpxUrl}
                    onChange={(event) => setGpxUrl(event.target.value)}
                  />
                </div>
              )}

              <div className="space-y-2">
                <Label>Layer types</Label>
                <div className="grid gap-2 sm:grid-cols-3">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedGpxLayerKinds.waypoints}
                      onChange={(event) =>
                        setGpxLayerKindSelected(
                          "waypoints",
                          event.target.checked,
                        )
                      }
                    />
                    Waypoints
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedGpxLayerKinds.tracks}
                      onChange={(event) =>
                        setGpxLayerKindSelected("tracks", event.target.checked)
                      }
                    />
                    Tracks
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedGpxLayerKinds.routes}
                      onChange={(event) =>
                        setGpxLayerKindSelected("routes", event.target.checked)
                      }
                    />
                    Routes
                  </label>
                </div>
              </div>
            </div>
          )}

          {kind === "delimited-text" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="delimited-text-mode">Source type</Label>
                <Select
                  id="delimited-text-mode"
                  value={delimitedTextMode}
                  onChange={(event) =>
                    handleDelimitedTextModeChange(
                      event.target.value as DelimitedTextMode,
                    )
                  }
                >
                  <option value="url">Delimited text URL</option>
                  <option value="file">Delimited text file</option>
                </Select>
              </div>

              {delimitedTextMode === "file" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleChooseDelimitedText}
                  >
                    <FileUp className="mr-2 h-3.5 w-3.5" />
                    Choose file
                  </Button>
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {selectedDelimitedText
                      ? fileNameFromPath(selectedDelimitedText.path)
                      : "No file selected"}
                  </span>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor="delimited-text-url">
                    Delimited text URL
                  </Label>
                  <Input
                    id="delimited-text-url"
                    placeholder="https://example.com/data.csv"
                    value={delimitedTextUrl}
                    onChange={(event) => {
                      setDelimitedTextUrl(event.target.value);
                      resetDelimitedTextColumns();
                    }}
                  />
                </div>
              )}

              <Button
                type="button"
                variant="outline"
                onClick={handleRetrieveDelimitedTextColumns}
                disabled={
                  isSubmitting ||
                  isRetrievingDelimitedTextColumns ||
                  missingCustomDelimiter ||
                  (delimitedTextMode === "file" && !selectedDelimitedText) ||
                  (delimitedTextMode === "url" && !delimitedTextUrl.trim())
                }
              >
                <Columns3 className="mr-2 h-3.5 w-3.5" />
                {isRetrievingDelimitedTextColumns
                  ? "Retrieving..."
                  : "Retrieve columns"}
              </Button>
              {delimitedTextColumnsStatus ? (
                <p className="text-xs text-muted-foreground">
                  {delimitedTextColumnsStatus}
                </p>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="delimited-text-delimiter">Delimiter</Label>
                  <Select
                    id="delimited-text-delimiter"
                    value={delimitedTextDelimiter}
                    onChange={(event) => {
                      setDelimitedTextDelimiter(
                        event.target.value as DelimitedTextDelimiter,
                      );
                      resetDelimitedTextColumns();
                    }}
                  >
                    <option value="comma">Comma</option>
                    <option value="tab">Tab</option>
                    <option value="semicolon">Semicolon</option>
                    <option value="pipe">Pipe</option>
                    <option value="custom">Custom</option>
                  </Select>
                </div>
                {delimitedTextDelimiter === "custom" ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="delimited-text-custom-delimiter">
                      Custom delimiter
                    </Label>
                    <Input
                      id="delimited-text-custom-delimiter"
                      value={delimitedTextCustomDelimiter}
                      onChange={(event) => {
                        setDelimitedTextCustomDelimiter(event.target.value);
                        resetDelimitedTextColumns();
                      }}
                    />
                  </div>
                ) : null}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="delimited-text-longitude">
                    Longitude field
                  </Label>
                  <Select
                    id="delimited-text-longitude"
                    value={delimitedTextLongitudeField}
                    onChange={(event) =>
                      setDelimitedTextLongitudeField(event.target.value)
                    }
                  >
                    {delimitedTextFieldOptions.map((field) => (
                      <option key={field} value={field}>
                        {field}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="delimited-text-latitude">
                    Latitude field
                  </Label>
                  <Select
                    id="delimited-text-latitude"
                    value={delimitedTextLatitudeField}
                    onChange={(event) =>
                      setDelimitedTextLatitudeField(event.target.value)
                    }
                  >
                    {delimitedTextFieldOptions.map((field) => (
                      <option key={field} value={field}>
                        {field}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
            </div>
          )}

          {kind === "mbtiles" && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleChooseMbtilesFile}
                >
                  <FileUp className="mr-2 h-3.5 w-3.5" />
                  Choose file
                </Button>
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {selectedMbtiles
                    ? fileNameFromPath(selectedMbtiles.path)
                    : "No file selected"}
                </span>
              </div>
              {selectedMbtiles && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>Tile type</Label>
                    <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                      {selectedMbtiles.metadata.tileType}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Format</Label>
                    <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                      {selectedMbtiles.metadata.format}
                    </div>
                  </div>
                </div>
              )}
              {selectedMbtiles?.metadata.tileType === "vector" && (
                <div className="space-y-1.5">
                  <Label htmlFor="mbtiles-source-layers">Source layers</Label>
                  <Input
                    id="mbtiles-source-layers"
                    placeholder="building, place, water"
                    value={mbtilesSourceLayers}
                    onChange={(event) =>
                      setMbtilesSourceLayers(event.target.value)
                    }
                  />
                </div>
              )}
            </div>
          )}

          {kind === "arcgis" && (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="arcgis-layer-type">Layer type</Label>
                  <Select
                    id="arcgis-layer-type"
                    value={arcgisLayerType}
                    onChange={(event) =>
                      handleArcgisLayerTypeChange(
                        event.target.value as ArcGISLayerType,
                      )
                    }
                  >
                    <option value="feature">Feature layer</option>
                    <option value="vector-tile">Vector tile layer</option>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="arcgis-source-type">Source type</Label>
                  <Select
                    id="arcgis-source-type"
                    value={arcgisSourceType}
                    onChange={(event) =>
                      setArcgisSourceType(event.target.value as ArcGISSourceType)
                    }
                  >
                    <option value="url">Service URL</option>
                    <option value="portal-item">Portal item ID</option>
                  </Select>
                </div>
              </div>
              {arcgisSourceType === "url" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="arcgis-url">Service URL</Label>
                  <Input
                    id="arcgis-url"
                    placeholder={
                      arcgisLayerType === "feature"
                        ? "https://services.arcgis.com/.../FeatureServer/0"
                        : "https://.../arcgis/rest/services/.../VectorTileServer"
                    }
                    value={arcgisUrl}
                    onChange={(event) => setArcgisUrl(event.target.value)}
                  />
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor="arcgis-item-id">Portal item ID</Label>
                  <Input
                    id="arcgis-item-id"
                    value={arcgisItemId}
                    onChange={(event) => setArcgisItemId(event.target.value)}
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="arcgis-portal-url">Portal URL</Label>
                <Input
                  id="arcgis-portal-url"
                  placeholder="https://www.arcgis.com/sharing/rest"
                  value={arcgisPortalUrl}
                  onChange={(event) => setArcgisPortalUrl(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="arcgis-access-token">Access token</Label>
                <Input
                  id="arcgis-access-token"
                  type="password"
                  autoComplete="off"
                  placeholder="Optional"
                  value={arcgisAccessToken}
                  onChange={(event) =>
                    setArcgisAccessToken(event.target.value)
                  }
                />
              </div>
            </div>
          )}

          {kind === "postgres" && (
            <div className="space-y-3">
              {!isTauri() ? (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                  PostgreSQL layers are only available in GeoLibre Desktop. This
                  feature runs a local Martin tile server, which the web app
                  cannot launch.
                </p>
              ) : null}
              {savedPostgresConnections.length > 0 ? (
                <div className="space-y-1.5">
                  <Label htmlFor="postgres-saved-connection">
                    Saved connection
                  </Label>
                  <Select
                    id="postgres-saved-connection"
                    value={
                      savedPostgresConnections.includes(
                        postgresConnectionString,
                      )
                        ? postgresConnectionString
                        : ""
                    }
                    onChange={(event) =>
                      setPostgresConnectionString(event.target.value)
                    }
                  >
                    <option value="">Select saved connection</option>
                    {savedPostgresConnections.map((connection) => (
                      <option key={connection} value={connection}>
                        {savedPostgresConnectionLabel(connection)}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : null}
              <div className="space-y-1.5">
                <Label htmlFor="postgres-connection">
                  PostgreSQL connection string
                </Label>
                <Input
                  id="postgres-connection"
                  type="password"
                  autoComplete="off"
                  placeholder="postgres://user:password@host:5432/database"
                  value={postgresConnectionString}
                  onChange={(event) =>
                    setPostgresConnectionString(event.target.value)
                  }
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <div className="space-y-1.5">
                  <Label htmlFor="postgres-default-srid">Default SRID</Label>
                  <Input
                    id="postgres-default-srid"
                    inputMode="numeric"
                    placeholder="Optional"
                    value={postgresDefaultSrid}
                    onChange={(event) =>
                      setPostgresDefaultSrid(event.target.value)
                    }
                  />
                </div>
                <div className="flex items-end">
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleConnectPostgres}
                      disabled={isSubmitting || !isTauri()}
                    >
                      Connect
                    </Button>
                    {martinServer ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleStopMartin}
                        disabled={isSubmitting}
                      >
                        Stop
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
              {martinStatus ? (
                <p className="text-xs text-muted-foreground">{martinStatus}</p>
              ) : null}
              {martinSources.length > 0 ? (
                <div className="space-y-1.5">
                  <Label htmlFor="martin-source">Martin source</Label>
                  <Select
                    id="martin-source"
                    value={selectedMartinSourceId}
                    onChange={(event) =>
                      setSelectedMartinSourceId(event.target.value)
                    }
                  >
                    {martinSources.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.name}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : null}
              {martinServer ? (
                <p className="text-xs text-muted-foreground">
                  Martin is running on port {martinServer.port}.
                </p>
              ) : null}
            </div>
          )}

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={closeDialog}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={addLayerDisabled}>
              {!isSubmitting ? (
                kind === "wms" || kind === "wfs" || kind === "wmts" ? (
                  <Globe2 className="mr-2 h-3.5 w-3.5" />
                ) : (
                  <MapIcon className="mr-2 h-3.5 w-3.5" />
                )
              ) : null}
              {isSubmitting ? "Adding…" : "Add layer"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
