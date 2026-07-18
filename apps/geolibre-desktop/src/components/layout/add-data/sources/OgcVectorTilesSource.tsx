import { Input, Label } from "@geolibre/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { resolveOgcVectorTiles } from "../../../../lib/ogc-vector-tiles";
import { DEFAULT_OGC_VECTOR_TILES_STYLE_URL, DEFAULT_OGC_VECTOR_TILES_URL } from "../constants";
import { createBaseLayer } from "../helpers";
import { AddDataSourceForm, SampleDataSelect, useAddDataSource } from "../shared";

interface OgcSample {
  tilesUrl: string;
  styleUrl: string;
}

/**
 * Adds an OGC API - Tiles (vector) source as a MapLibre vector layer. The user
 * supplies a TileJSON metadata URL or a `{z}/{y}/{x}` MVT template, and may add
 * a Mapbox/MapLibre style URL to discover the tileset's source layers (an OGC
 * API TileJSON often omits them). Rendering uses GeoLibre's default per-source
 * layer styling; the style's own paint is not applied.
 */
export function OgcVectorTilesSource() {
  const { t } = useTranslation();
  const source = useAddDataSource(t("addData.ogcVectorTiles.defaultName"));
  const [tilesUrl, setTilesUrl] = useState("");
  const [styleUrl, setStyleUrl] = useState("");
  const [sourceLayersText, setSourceLayersText] = useState("");

  // Cancel the in-flight metadata/style/collections fetches if the dialog closes
  // mid-request, so a slow response cannot add the layer after the user leaves.
  const resolveAbortRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      resolveAbortRef.current?.abort();
    },
    [],
  );

  const applySample = (sample: OgcSample) => {
    setTilesUrl(sample.tilesUrl);
    setStyleUrl(sample.styleUrl);
    setSourceLayersText("");
  };

  const handleSubmit = source.runSubmit(async () => {
    if (!tilesUrl.trim() && !styleUrl.trim()) {
      throw new Error(t("addData.ogcVectorTiles.errorUrl"));
    }
    const manualLayers = sourceLayersText
      .split(",")
      .map((layer) => layer.trim())
      .filter(Boolean);
    resolveAbortRef.current?.abort();
    const controller = new AbortController();
    resolveAbortRef.current = controller;
    const config = await resolveOgcVectorTiles({
      tilesUrl: tilesUrl.trim(),
      styleUrl: styleUrl.trim() || undefined,
      sourceLayers: manualLayers,
      signal: controller.signal,
    });
    // A superseded/cancelled request must not add a layer after the fact.
    if (controller.signal.aborted) return;
    if (!config.url && !(config.tiles && config.tiles.length > 0)) {
      throw new Error(t("addData.ogcVectorTiles.errorNoTiles"));
    }
    if (config.sourceLayers.length === 0) {
      throw new Error(t("addData.ogcVectorTiles.errorNoLayers"));
    }
    const name = source.layerName.trim() || config.name || t("addData.ogcVectorTiles.defaultName");
    source.addAndClose(
      createBaseLayer(
        name,
        "vector-tiles",
        {
          type: "vector",
          ...(config.url ? { url: config.url } : {}),
          ...(config.tiles ? { tiles: config.tiles } : {}),
          sourceLayer: config.sourceLayers[0],
          sourceLayers: config.sourceLayers,
          bounds: config.bounds,
          minzoom: config.minzoom,
          maxzoom: config.maxzoom,
        },
        {
          bounds: config.bounds,
          center: config.center,
          minzoom: config.minzoom,
          maxzoom: config.maxzoom,
          sourceKind: "ogc-vector-tiles",
          sourceLayers: config.sourceLayers,
          tilesUrl: tilesUrl.trim() || undefined,
          styleUrl: styleUrl.trim() || undefined,
        },
      ),
      // fitLayer resolves a vector-tiles layer only from bounds (it never reads
      // `center` for this type), so only request a fit when bounds are known.
      { fit: Boolean(config.bounds) },
    );
  });

  return (
    <AddDataSourceForm
      layerName={source.layerName}
      onLayerNameChange={source.setLayerName}
      beforeLayerId={source.beforeLayerId}
      onBeforeLayerIdChange={source.setBeforeLayerId}
      onSubmit={handleSubmit}
      error={source.error}
      submitDisabled={source.isSubmitting}
      useServiceIcon
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="ogc-vt-tiles-url">{t("addData.ogcVectorTiles.tilesUrl")}</Label>
          <Input
            id="ogc-vt-tiles-url"
            placeholder={t("addData.ogcVectorTiles.tilesUrlPlaceholder")}
            value={tilesUrl}
            onChange={(event) => setTilesUrl(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t("addData.ogcVectorTiles.tilesUrlHint")}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ogc-vt-style-url">{t("addData.ogcVectorTiles.styleUrl")}</Label>
          <Input
            id="ogc-vt-style-url"
            placeholder={t("addData.ogcVectorTiles.styleUrlPlaceholder")}
            value={styleUrl}
            onChange={(event) => setStyleUrl(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t("addData.ogcVectorTiles.styleUrlHint")}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ogc-vt-source-layers">{t("addData.ogcVectorTiles.sourceLayers")}</Label>
          <Input
            id="ogc-vt-source-layers"
            placeholder={t("addData.ogcVectorTiles.sourceLayersPlaceholder")}
            value={sourceLayersText}
            onChange={(event) => setSourceLayersText(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t("addData.ogcVectorTiles.sourceLayersHint")}
          </p>
        </div>
        <SampleDataSelect
          samples={[
            {
              label: t("addData.ogcVectorTiles.sampleLabel"),
              value: {
                tilesUrl: DEFAULT_OGC_VECTOR_TILES_URL,
                styleUrl: DEFAULT_OGC_VECTOR_TILES_STYLE_URL,
              },
            },
          ]}
          onSelect={applySample}
        />
      </div>
    </AddDataSourceForm>
  );
}
