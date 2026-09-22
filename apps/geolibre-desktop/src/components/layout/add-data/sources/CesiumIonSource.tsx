import {
  CESIUM_ION_QUICK_PICKS,
  createCesiumIonLayer,
  parseCesiumIonAssetId,
  type CesiumIonAssetKind,
} from "@geolibre/core";
import { Input, Label, Select } from "@geolibre/ui";
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

  // The dropdown mirrors the form rather than holding its own state: typing an
  // asset id by hand, or switching the layer type, drops it back to the
  // placeholder instead of leaving a stale pick selected.
  const selectedPick = CESIUM_ION_QUICK_PICKS.find(
    (pick) => String(pick.assetId) === assetId.trim() && pick.kind === kind,
  );
  const globalPicks = CESIUM_ION_QUICK_PICKS.filter((pick) => pick.group === "global");
  const depotPicks = CESIUM_ION_QUICK_PICKS.filter((pick) => pick.group === "depot");

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
          <Label htmlFor="cesium-ion-quick-pick">{t("addData.cesiumIon.quickPicks")}</Label>
          <Select
            id="cesium-ion-quick-pick"
            value={selectedPick ? String(selectedPick.assetId) : ""}
            onChange={(event) => {
              const pick = CESIUM_ION_QUICK_PICKS.find(
                (candidate) => String(candidate.assetId) === event.target.value,
              );
              if (!pick) {
                // Re-picking the placeholder means "I'll type an id myself", so
                // drop what the previous pick filled in, the way the Deck.gl
                // sample dropdown drops a sample's placement. Returning without
                // a state change would leave the native select showing the
                // placeholder while the fields below still held the old pick.
                setAssetId("");
                setKind("3d-tiles");
                source.setLayerName(t("addData.cesiumIon.defaultName"));
                return;
              }
              setAssetId(String(pick.assetId));
              setKind(pick.kind);
              source.setLayerName(pick.name);
            }}
          >
            <option value="">{t("addData.cesiumIon.quickPicksPlaceholder")}</option>
            <optgroup label={t("addData.cesiumIon.quickPicksGlobal")}>
              {globalPicks.map((pick) => (
                <option key={pick.assetId} value={String(pick.assetId)}>
                  {pick.name}
                </option>
              ))}
            </optgroup>
            <optgroup label={t("addData.cesiumIon.quickPicksDepot")}>
              {depotPicks.map((pick) => (
                <option key={pick.assetId} value={String(pick.assetId)}>
                  {pick.name}
                </option>
              ))}
            </optgroup>
          </Select>
          <p className="text-xs text-muted-foreground">
            {selectedPick?.group === "depot"
              ? t("addData.cesiumIon.depotHint")
              : t("addData.cesiumIon.hint")}
          </p>
        </div>
      </div>
    </AddDataSourceForm>
  );
}
