import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  useAppStore,
} from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  addCogRasterLayer,
  type CogRasterLayerOptions,
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
} from "@geolibre/ui";
import type { FeatureCollection } from "geojson";
import { Database, FileUp, Globe2, Image, Map as MapIcon } from "lucide-react";
import {
  type FormEvent,
  type RefObject,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  openLocalDataFileWithFallback,
  openVectorFileWithFallback,
} from "../../lib/tauri-io";
import { createAppAPI } from "../../hooks/usePlugins";
import {
  mbtilesTileUrl,
  readMbtilesMetadata,
  registerMbtilesProtocol,
  type MbtilesMetadata,
} from "../../lib/mbtiles";

export type AddDataKind = "xyz" | "wms" | "vector" | "raster" | "mbtiles";

interface AddDataDialogProps {
  kind: AddDataKind | null;
  mapControllerRef: RefObject<MapController | null>;
  onOpenChange: (open: boolean) => void;
}

type VectorMode = "vector-file" | "geojson-url" | "vector-tiles";
type RasterMode = "tiles" | "cog-url" | "file";
type RasterColormap = NonNullable<CogRasterLayerOptions["colormap"]>;

const KIND_LABELS: Record<AddDataKind, string> = {
  xyz: "Add XYZ Layer",
  wms: "Add WMS Layer",
  vector: "Add Vector Layer",
  raster: "Add Raster Layer",
  mbtiles: "Add MBTiles Layer",
};

const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const COG_COLORMAPS = [
  "none",
  "viridis",
  "plasma",
  "inferno",
  "magma",
  "cividis",
  "terrain",
  "turbo",
  "jet",
  "gray",
] satisfies RasterColormap[];

const DEFAULT_RASTER_URL =
  "https://data.source.coop/giswqs/opengeos/nlcd_2021_land_cover_30m.tif";

function createLayerId(): string {
  return crypto.randomUUID();
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

async function fetchGeoJson(url: string): Promise<FeatureCollection> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  return (await response.json()) as FeatureCollection;
}

export function AddDataDialog({
  kind,
  mapControllerRef,
  onOpenChange,
}: AddDataDialogProps) {
  const open = kind !== null;
  const addLayer = useAppStore((s) => s.addLayer);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const title = kind ? KIND_LABELS[kind] : "Add Data";

  const [layerName, setLayerName] = useState("");
  const [beforeLayerId, setBeforeLayerId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [xyzUrl, setXyzUrl] = useState("");
  const [xyzTileSize, setXyzTileSize] = useState("256");

  const [wmsEndpoint, setWmsEndpoint] = useState("");
  const [wmsLayers, setWmsLayers] = useState("");
  const [wmsStyles, setWmsStyles] = useState("");
  const [wmsFormat, setWmsFormat] = useState("image/png");
  const [wmsTransparent, setWmsTransparent] = useState(true);
  const [wmsTileSize, setWmsTileSize] = useState("256");

  const [vectorMode, setVectorMode] = useState<VectorMode>("vector-file");
  const [vectorUrl, setVectorUrl] = useState("");
  const [vectorSourceLayer, setVectorSourceLayer] = useState("");
  const [selectedVector, setSelectedVector] = useState<{
    data: FeatureCollection;
    path: string;
  } | null>(null);

  const [rasterMode, setRasterMode] = useState<RasterMode>("cog-url");
  const [rasterUrl, setRasterUrl] = useState(DEFAULT_RASTER_URL);
  const [rasterTileSize, setRasterTileSize] = useState("256");
  const [rasterBands, setRasterBands] = useState("1");
  const [rasterColormap, setRasterColormap] = useState<RasterColormap>("none");
  const [rasterMin, setRasterMin] = useState("0");
  const [rasterMax, setRasterMax] = useState("255");
  const [rasterNodata, setRasterNodata] = useState("");
  const [selectedRasterPath, setSelectedRasterPath] = useState<string | null>(
    null,
  );
  const [selectedMbtiles, setSelectedMbtiles] = useState<{
    metadata: MbtilesMetadata;
    path: string;
  } | null>(null);
  const [mbtilesSourceLayers, setMbtilesSourceLayers] = useState("");

  useEffect(() => {
    if (!kind) return;
    setError(null);
    setIsSubmitting(false);
    setLayerName(
      {
        xyz: "XYZ Layer",
        wms: "WMS Layer",
        vector: "Vector Layer",
        raster: "Raster Layer",
        mbtiles: "MBTiles Layer",
      }[kind],
    );
    setBeforeLayerId("");
    setXyzUrl("");
    setXyzTileSize("256");
    setWmsEndpoint("");
    setWmsLayers("");
    setWmsStyles("");
    setWmsFormat("image/png");
    setWmsTransparent(true);
    setWmsTileSize("256");
    setVectorMode("vector-file");
    setVectorUrl("");
    setVectorSourceLayer("");
    setSelectedVector(null);
    setRasterMode("cog-url");
    setRasterUrl(DEFAULT_RASTER_URL);
    setRasterTileSize("256");
    setRasterBands("1");
    setRasterColormap("none");
    setRasterMin("0");
    setRasterMax("255");
    setRasterNodata("");
    setSelectedRasterPath(null);
    setSelectedMbtiles(null);
    setMbtilesSourceLayers("");
  }, [kind]);

  const description = useMemo(() => {
    if (kind === "xyz") {
      return "Add a raster tile template using x, y, and z placeholders.";
    }
    if (kind === "wms") {
      return "Add a WMS GetMap service as a tiled raster layer.";
    }
    if (kind === "vector") {
      return "Add local vector files supported by DuckDB Spatial, GeoJSON URLs, or MapLibre vector tile sources.";
    }
    if (kind === "raster") {
      return "Add a Cloud Optimized GeoTIFF or raster URL, or use a raster tile template.";
    }
    if (kind === "mbtiles") {
      return "Add a local MBTiles file as a raster or vector tile layer.";
    }
    return "";
  }, [kind]);

  const closeDialog = () => onOpenChange(false);

  const handleOpenChange = (next: boolean) => {
    if (!next && isSubmitting) return;
    onOpenChange(next);
  };

  const beforeLayer = beforeLayerId.trim() || null;

  const addAndClose = (layer: GeoLibreLayer) => {
    addLayer(layer, beforeLayer);
    closeDialog();
  };

  const handleChooseVector = async () => {
    setError(null);
    try {
      const result = await openVectorFileWithFallback();
      if (!result) return;
      setSelectedVector(result);
      setLayerName((current) =>
        current.trim() && current !== "Vector Layer"
          ? current
          : layerNameFromPath(result.path, "Vector Layer"),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read file.");
    }
  };

  const handleChooseRasterFile = async () => {
    setError(null);
    const result = await openLocalDataFileWithFallback({
      filters: [
        {
          name: "GeoTIFF raster",
          extensions: ["tif", "tiff"],
        },
      ],
      accept: ".tif,.tiff",
    });
    if (!result) return;
    setSelectedRasterPath(result.path);
    setLayerName((current) =>
      current.trim() && current !== "Raster Layer"
        ? current
        : layerNameFromPath(result.path, "Raster Layer"),
    );
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
      setError(
        err instanceof Error ? err.message : "Could not read MBTiles file.",
      );
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
        addAndClose(
          createBaseLayer(name, "xyz", {
            type: "raster",
            tiles: [xyzUrl.trim()],
            tileSize: Number(xyzTileSize) || 256,
          }),
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

      if (kind === "vector") {
        if (vectorMode === "vector-file") {
          if (!selectedVector) throw new Error("Choose a vector file.");
          const id = addGeoJsonLayer(
            name,
            selectedVector.data,
            selectedVector.path,
            beforeLayer,
          );
          const layer = useAppStore.getState().layers.find((l) => l.id === id);
          if (layer) mapControllerRef.current?.fitLayer(layer);
          closeDialog();
          return;
        }

        if (vectorMode === "geojson-url") {
          if (!vectorUrl.trim()) throw new Error("Enter a GeoJSON URL.");
          const data = await fetchGeoJson(vectorUrl.trim());
          const id = addGeoJsonLayer(name, data, vectorUrl.trim(), beforeLayer);
          const layer = useAppStore.getState().layers.find((l) => l.id === id);
          if (layer) mapControllerRef.current?.fitLayer(layer);
          closeDialog();
          return;
        }

        if (!vectorUrl.trim())
          throw new Error("Enter a vector tile source URL.");
        if (!vectorSourceLayer.trim()) {
          throw new Error("Enter the vector tile source layer name.");
        }
        addAndClose(
          createBaseLayer(name, "vector-tiles", {
            type: "vector",
            url: vectorUrl.trim(),
            sourceLayer: vectorSourceLayer.trim(),
          }),
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

      if (rasterMode === "tiles") {
        if (!rasterUrl.trim()) {
          throw new Error("Enter a raster tile URL template.");
        }
        addAndClose(
          createBaseLayer(name, "raster", {
            type: "raster",
            tiles: [rasterUrl.trim()],
            tileSize: Number(rasterTileSize) || 256,
          }),
        );
        return;
      }

      if (rasterMode === "cog-url") {
        if (!rasterUrl.trim()) throw new Error("Enter a raster URL.");
        const rescaleMin = parseRequiredNumber(rasterMin, "minimum value");
        const rescaleMax = parseRequiredNumber(rasterMax, "maximum value");
        if (rescaleMax <= rescaleMin) {
          throw new Error("Maximum value must be greater than minimum value.");
        }
        await addCogRasterLayer(createAppAPI(mapControllerRef), {
          bands: rasterBands.trim() || "1",
          beforeLayerId: beforeLayer,
          colormap: rasterColormap,
          name,
          nodata: parseOptionalNumber(rasterNodata, "nodata value"),
          opacity: 1,
          rescaleMax,
          rescaleMin,
          url: rasterUrl.trim(),
        });
        closeDialog();
        return;
      }

      if (!selectedRasterPath) throw new Error("Choose a raster file.");
      const rescaleMin = parseRequiredNumber(rasterMin, "minimum value");
      const rescaleMax = parseRequiredNumber(rasterMax, "maximum value");
      if (rescaleMax <= rescaleMin) {
        throw new Error("Maximum value must be greater than minimum value.");
      }
      await addCogRasterLayer(createAppAPI(mapControllerRef), {
        bands: rasterBands.trim() || "1",
        beforeLayerId: beforeLayer,
        colormap: rasterColormap,
        name,
        nodata: parseOptionalNumber(rasterNodata, "nodata value"),
        opacity: 1,
        rescaleMax,
        rescaleMin,
        url: selectedRasterPath,
      });
      closeDialog();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add layer.");
    } finally {
      setIsSubmitting(false);
    }
  };

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
            <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
              <div className="space-y-1.5">
                <Label htmlFor="xyz-url">Tile URL template</Label>
                <Input
                  id="xyz-url"
                  placeholder="https://example.com/{z}/{x}/{y}.png"
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
                  <select
                    id="wms-format"
                    className={SELECT_CLASS}
                    value={wmsFormat}
                    onChange={(event) => setWmsFormat(event.target.value)}
                  >
                    <option value="image/png">PNG</option>
                    <option value="image/jpeg">JPEG</option>
                  </select>
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

          {kind === "vector" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="vector-mode">Source type</Label>
                <select
                  id="vector-mode"
                  className={SELECT_CLASS}
                  value={vectorMode}
                  onChange={(event) =>
                    setVectorMode(event.target.value as VectorMode)
                  }
                >
                  <option value="vector-file">Vector file</option>
                  <option value="geojson-url">GeoJSON URL</option>
                  <option value="vector-tiles">Vector tile source URL</option>
                </select>
              </div>
              {vectorMode === "vector-file" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleChooseVector}
                  >
                    <FileUp className="mr-2 h-3.5 w-3.5" />
                    Choose file
                  </Button>
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {selectedVector
                      ? fileNameFromPath(selectedVector.path)
                      : "No file selected"}
                  </span>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor="vector-url">
                    {vectorMode === "geojson-url"
                      ? "GeoJSON URL"
                      : "Source URL"}
                  </Label>
                  <Input
                    id="vector-url"
                    placeholder={
                      vectorMode === "geojson-url"
                        ? "https://example.com/data.geojson"
                        : "mapbox://tileset or https://example.com/tiles.json"
                    }
                    value={vectorUrl}
                    onChange={(event) => setVectorUrl(event.target.value)}
                  />
                </div>
              )}
              {vectorMode === "vector-tiles" && (
                <div className="space-y-1.5">
                  <Label htmlFor="vector-source-layer">Source layer</Label>
                  <Input
                    id="vector-source-layer"
                    value={vectorSourceLayer}
                    onChange={(event) =>
                      setVectorSourceLayer(event.target.value)
                    }
                  />
                </div>
              )}
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

          {kind === "raster" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="raster-mode">Source type</Label>
                <select
                  id="raster-mode"
                  className={SELECT_CLASS}
                  value={rasterMode}
                  onChange={(event) =>
                    setRasterMode(event.target.value as RasterMode)
                  }
                >
                  <option value="cog-url">COG or raster URL</option>
                  <option value="tiles">Raster tile URL template</option>
                  <option value="file">Raster file</option>
                </select>
              </div>
              {rasterMode === "file" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleChooseRasterFile}
                  >
                    <Image className="mr-2 h-3.5 w-3.5" />
                    Choose file
                  </Button>
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {selectedRasterPath
                      ? fileNameFromPath(selectedRasterPath)
                      : "No file selected"}
                  </span>
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
                  <div className="space-y-1.5">
                    <Label htmlFor="raster-url">
                      {rasterMode === "tiles"
                        ? "Tile URL template"
                        : "Raster URL"}
                    </Label>
                    <Input
                      id="raster-url"
                      placeholder={
                        rasterMode === "tiles"
                          ? "https://example.com/{z}/{x}/{y}.png"
                          : "https://example.com/image.tif"
                      }
                      value={rasterUrl}
                      onChange={(event) => setRasterUrl(event.target.value)}
                    />
                  </div>
                  {rasterMode === "tiles" && (
                    <div className="space-y-1.5">
                      <Label htmlFor="raster-tile-size">Tile size</Label>
                      <Input
                        id="raster-tile-size"
                        inputMode="numeric"
                        value={rasterTileSize}
                        onChange={(event) =>
                          setRasterTileSize(event.target.value)
                        }
                      />
                    </div>
                  )}
                </div>
              )}
              {rasterMode !== "tiles" && (
                <div className="grid gap-3 sm:grid-cols-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="raster-bands">Bands</Label>
                    <Input
                      id="raster-bands"
                      placeholder="1 or 1,2,3"
                      value={rasterBands}
                      onChange={(event) => setRasterBands(event.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="raster-colormap">Colormap</Label>
                    <select
                      id="raster-colormap"
                      className={SELECT_CLASS}
                      value={rasterColormap}
                      onChange={(event) =>
                        setRasterColormap(event.target.value as RasterColormap)
                      }
                    >
                      {COG_COLORMAPS.map((colormap) => (
                        <option key={colormap} value={colormap}>
                          {colormap}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="raster-min">Min</Label>
                    <Input
                      id="raster-min"
                      inputMode="decimal"
                      value={rasterMin}
                      onChange={(event) => setRasterMin(event.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="raster-max">Max</Label>
                    <Input
                      id="raster-max"
                      inputMode="decimal"
                      value={rasterMax}
                      onChange={(event) => setRasterMax(event.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="raster-nodata">Nodata</Label>
                    <Input
                      id="raster-nodata"
                      inputMode="decimal"
                      placeholder="Optional"
                      value={rasterNodata}
                      onChange={(event) => setRasterNodata(event.target.value)}
                    />
                  </div>
                </div>
              )}
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
            <Button type="submit" disabled={isSubmitting}>
              {kind === "wms" ? (
                <Globe2 className="mr-2 h-3.5 w-3.5" />
              ) : kind === "raster" ? (
                <Image className="mr-2 h-3.5 w-3.5" />
              ) : (
                <MapIcon className="mr-2 h-3.5 w-3.5" />
              )}
              Add layer
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
