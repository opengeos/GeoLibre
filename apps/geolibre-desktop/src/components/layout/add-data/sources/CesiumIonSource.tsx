import {
  CESIUM_ION_QUICK_PICKS,
  createCesiumIonLayer,
  parseCesiumIonAssetId,
  type CesiumIonAssetKind,
} from "@geolibre/core";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useCesiumIonToken } from "../../../../hooks/useCesiumIonToken";
import { AddDataSourceForm, useAddDataSource } from "../shared";

/**
 * Add a Cesium Ion asset by id (issue #2290): a 3D Tiles tileset or an
 * imagery layer the globe loads with the configured Ion token. The 2D map
 * cannot draw these, so the Add Data menu offers this source on the globe
 * only; the form itself is renderer-agnostic.
 */
export function CesiumIonSource() {
  const { t } = useTranslation();
  const source = useAddDataSource(t("addData.cesiumIon.defaultName"));
  const token = useCesiumIonToken();
  const [assetId, setAssetId] = useState("");
  const [kind, setKind] = useState<CesiumIonAssetKind>("3d-tiles");
  const [altitudeOffset, setAltitudeOffset] = useState("0");

  const handleSubmit = source.runSubmit(() => {
    const id = parseCesiumIonAssetId(assetId);
    if (id === null) throw new Error(t("addData.cesiumIon.errorAssetId"));
    const offset = altitudeOffset.trim() === "" ? 0 : Number(altitudeOffset);
    if (kind === "3d-tiles" && !Number.isFinite(offset)) {
      throw new Error(t("addData.cesiumIon.errorAltitude"));
    }
    const name = source.layerName.trim() || t("addData.cesiumIon.defaultName");
    source.addAndClose(
      createCesiumIonLayer({
        name,
        assetId: id,
        kind,
        altitudeOffset: kind === "3d-tiles" ? offset : 0,
      }),
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
        {!token ? (
          <p className="text-xs text-amber-600">{t("addData.cesiumIon.tokenMissing")}</p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-[1fr_11rem]">
          <div className="space-y-1.5">
            <Label htmlFor="cesium-ion-asset-id">{t("addData.cesiumIon.assetId")}</Label>
            <Input
              id="cesium-ion-asset-id"
              inputMode="numeric"
              placeholder="96188"
              value={assetId}
              onChange={(event) => setAssetId(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cesium-ion-kind">{t("addData.common.layerType")}</Label>
            <Select
              id="cesium-ion-kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as CesiumIonAssetKind)}
            >
              <option value="3d-tiles">{t("addData.cesiumIon.kindTileset")}</option>
              <option value="imagery">{t("addData.cesiumIon.kindImagery")}</option>
            </Select>
          </div>
        </div>
        {kind === "3d-tiles" ? (
          <div className="space-y-1.5">
            <Label htmlFor="cesium-ion-altitude">{t("addData.cesiumIon.altitudeOffset")}</Label>
            <Input
              id="cesium-ion-altitude"
              inputMode="decimal"
              value={altitudeOffset}
              onChange={(event) => setAltitudeOffset(event.target.value)}
            />
          </div>
        ) : null}
        <div className="space-y-1.5">
          <Label>{t("addData.cesiumIon.quickPicks")}</Label>
          <div className="flex flex-wrap gap-2">
            {CESIUM_ION_QUICK_PICKS.map((pick) => (
              <Button
                key={pick.assetId}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setAssetId(String(pick.assetId));
                  setKind(pick.kind);
                  source.setLayerName(pick.name);
                }}
              >
                {pick.name}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t("addData.cesiumIon.hint")}</p>
        </div>
      </div>
    </AddDataSourceForm>
  );
}
