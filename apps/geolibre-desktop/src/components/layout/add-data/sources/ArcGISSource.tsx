import {
  addArcGISLayer,
  type ArcGISLayerType,
  type ArcGISSourceType,
} from "@geolibre/plugins";
import { Input, Label, Select } from "@geolibre/ui";
import { useState } from "react";
import { createAppAPI } from "../../../../hooks/usePlugins";
import {
  DEFAULT_ARCGIS_FEATURE_URL,
  DEFAULT_ARCGIS_URLS,
} from "../constants";
import { AddDataSourceForm, useAddDataSource } from "../shared";

export function ArcGISSource() {
  const source = useAddDataSource("ArcGIS Layer");
  const [arcgisLayerType, setArcgisLayerType] =
    useState<ArcGISLayerType>("feature");
  const [arcgisSourceType, setArcgisSourceType] =
    useState<ArcGISSourceType>("url");
  const [arcgisUrl, setArcgisUrl] = useState(DEFAULT_ARCGIS_FEATURE_URL);
  const [arcgisItemId, setArcgisItemId] = useState("");
  const [arcgisPortalUrl, setArcgisPortalUrl] = useState("");
  const [arcgisAccessToken, setArcgisAccessToken] = useState("");

  const handleArcgisLayerTypeChange = (nextLayerType: ArcGISLayerType) => {
    const currentUrl = arcgisUrl.trim();
    setArcgisLayerType(nextLayerType);
    if (!currentUrl || Object.values(DEFAULT_ARCGIS_URLS).includes(currentUrl)) {
      setArcgisUrl(DEFAULT_ARCGIS_URLS[nextLayerType]);
    }
  };

  const handleSubmit = source.runSubmit(async () => {
    const name = source.layerName.trim() || "ArcGIS Layer";
    await addArcGISLayer(createAppAPI(source.shell.mapControllerRef), {
      beforeLayerId: source.beforeLayer,
      itemId: arcgisItemId.trim() || undefined,
      layerType: arcgisLayerType,
      name,
      portalUrl: arcgisPortalUrl.trim() || undefined,
      sourceType: arcgisSourceType,
      token: arcgisAccessToken.trim() || undefined,
      url: arcgisUrl.trim() || undefined,
    });
    source.shell.closeDialog();
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
            onChange={(event) => setArcgisAccessToken(event.target.value)}
          />
        </div>
      </div>
    </AddDataSourceForm>
  );
}
