import { Input, Label } from "@geolibre/ui";
import { useState } from "react";
import { DEFAULT_WMTS_URL } from "../constants";
import { createBaseLayer } from "../helpers";
import { AddDataSourceForm, useAddDataSource } from "../shared";

export function WmtsSource() {
  const source = useAddDataSource("WMTS Layer");
  const [wmtsUrl, setWmtsUrl] = useState(DEFAULT_WMTS_URL);
  const [wmtsTileSize, setWmtsTileSize] = useState("256");

  const handleSubmit = source.runSubmit(() => {
    const name = source.layerName.trim() || "WMTS Layer";
    if (!wmtsUrl.trim()) {
      throw new Error("Enter a WMTS tile URL template.");
    }
    source.addAndClose(
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
    </AddDataSourceForm>
  );
}
