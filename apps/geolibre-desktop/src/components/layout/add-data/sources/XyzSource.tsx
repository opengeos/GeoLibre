import { Input, Label } from "@geolibre/ui";
import { useState } from "react";
import {
  createXyzTileUrlTemplate,
  registerXyzTileProtocol,
  resolveXyzTileUrlTemplate,
} from "../../../../lib/xyz-url";
import { DEFAULT_XYZ_URL } from "../constants";
import { createBaseLayer } from "../helpers";
import { ServiceLibrarySection } from "../ServiceLibrarySection";
import {
  serviceFieldBoolean,
  serviceFieldString,
  type ServiceFields,
} from "../service-library";
import { AddDataSourceForm, useAddDataSource } from "../shared";

export function XyzSource() {
  const source = useAddDataSource("XYZ Layer");
  const [xyzUrl, setXyzUrl] = useState(DEFAULT_XYZ_URL);
  const [xyzTileSize, setXyzTileSize] = useState("256");
  const [xyzShortUrl, setXyzShortUrl] = useState(false);

  const getFields = (): ServiceFields => ({
    url: xyzUrl,
    tileSize: xyzTileSize,
    shortUrl: xyzShortUrl,
  });

  const applyFields = (fields: ServiceFields) => {
    setXyzUrl(serviceFieldString(fields, "url", DEFAULT_XYZ_URL));
    setXyzTileSize(serviceFieldString(fields, "tileSize", "256"));
    setXyzShortUrl(serviceFieldBoolean(fields, "shortUrl", false));
  };

  const handleSubmit = source.runSubmit(async () => {
    const name = source.layerName.trim() || "XYZ Layer";
    if (!xyzUrl.trim()) throw new Error("Enter an XYZ tile URL template.");
    if (xyzShortUrl) registerXyzTileProtocol();
    const tileUrl = xyzShortUrl
      ? await resolveXyzTileUrlTemplate(xyzUrl)
      : createXyzTileUrlTemplate(xyzUrl);
    source.addAndClose(
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
    >
      <div className="space-y-3">
        <ServiceLibrarySection
          kind="xyz"
          layerName={source.layerName}
          getFields={getFields}
          onApply={(entry) => {
            source.setLayerName(entry.name);
            applyFields(entry.fields);
          }}
        />
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
    </AddDataSourceForm>
  );
}
