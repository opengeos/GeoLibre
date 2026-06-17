import { Input, Label, Select } from "@geolibre/ui";
import { useState } from "react";
import { DEFAULT_WMS_ENDPOINT, DEFAULT_WMS_LAYERS } from "../constants";
import { createBaseLayer, createWmsTileUrl } from "../helpers";
import { ServiceLibrarySection } from "../ServiceLibrarySection";
import {
  serviceFieldBoolean,
  serviceFieldString,
  type ServiceFields,
} from "../service-library";
import { AddDataSourceForm, useAddDataSource } from "../shared";

export function WmsSource() {
  const source = useAddDataSource("WMS Layer");
  const [wmsEndpoint, setWmsEndpoint] = useState(DEFAULT_WMS_ENDPOINT);
  const [wmsLayers, setWmsLayers] = useState(DEFAULT_WMS_LAYERS);
  const [wmsStyles, setWmsStyles] = useState("");
  const [wmsFormat, setWmsFormat] = useState("image/png");
  const [wmsTransparent, setWmsTransparent] = useState(true);
  const [wmsTileSize, setWmsTileSize] = useState("256");

  const getFields = (): ServiceFields => ({
    endpoint: wmsEndpoint,
    layers: wmsLayers,
    styles: wmsStyles,
    format: wmsFormat,
    transparent: wmsTransparent,
    tileSize: wmsTileSize,
  });

  const applyFields = (fields: ServiceFields) => {
    setWmsEndpoint(serviceFieldString(fields, "endpoint", DEFAULT_WMS_ENDPOINT));
    setWmsLayers(serviceFieldString(fields, "layers", DEFAULT_WMS_LAYERS));
    setWmsStyles(serviceFieldString(fields, "styles"));
    setWmsFormat(serviceFieldString(fields, "format", "image/png"));
    setWmsTransparent(serviceFieldBoolean(fields, "transparent", true));
    setWmsTileSize(serviceFieldString(fields, "tileSize", "256"));
  };

  const handleSubmit = source.runSubmit(() => {
    const name = source.layerName.trim() || "WMS Layer";
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
    source.addAndClose(
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
        <ServiceLibrarySection
          kind="wms"
          layerName={source.layerName}
          getFields={getFields}
          onApply={(entry) => {
            source.setLayerName(entry.name);
            applyFields(entry.fields);
          }}
        />
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
    </AddDataSourceForm>
  );
}
