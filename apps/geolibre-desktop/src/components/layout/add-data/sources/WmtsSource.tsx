import { Input, Label } from "@geolibre/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { buildWmtsLayer } from "../apply-service";
import { DEFAULT_WMTS_URL } from "../constants";
import { ServiceLibrarySection } from "../ServiceLibrarySection";
import { serviceFieldString, type ServiceFields } from "../service-library";
import { AddDataSourceForm, SampleDataSelect, useAddDataSource } from "../shared";

export function WmtsSource() {
  const { t } = useTranslation();
  const source = useAddDataSource(t("addData.wmts.defaultName"));
  const [wmtsUrl, setWmtsUrl] = useState("");
  const [wmtsTileSize, setWmtsTileSize] = useState("256");

  const getFields = (): ServiceFields => ({
    url: wmtsUrl,
    tileSize: wmtsTileSize,
  });

  const applyFields = (fields: ServiceFields) => {
    setWmtsUrl(serviceFieldString(fields, "url"));
    setWmtsTileSize(serviceFieldString(fields, "tileSize", "256"));
  };

  const handleSubmit = source.runSubmit(() => {
    const name = source.layerName.trim() || t("addData.wmts.defaultName");
    if (!wmtsUrl.trim()) {
      throw new Error(t("addData.wmts.errorUrl"));
    }
    source.addAndClose(buildWmtsLayer({ name, url: wmtsUrl, tileSize: wmtsTileSize }));
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
          kind="wmts"
          layerName={source.layerName}
          getFields={getFields}
          onApply={(entry) => {
            source.setLayerName(entry.name);
            applyFields(entry.fields);
          }}
        />
        <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
          <div className="space-y-1.5">
            <Label htmlFor="wmts-url">{t("addData.common.tileUrlTemplate")}</Label>
            <Input
              id="wmts-url"
              placeholder={t("addData.wmts.urlPlaceholder")}
              value={wmtsUrl}
              onChange={(event) => setWmtsUrl(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wmts-tile-size">{t("addData.common.tileSize")}</Label>
            <Input
              id="wmts-tile-size"
              inputMode="numeric"
              value={wmtsTileSize}
              onChange={(event) => setWmtsTileSize(event.target.value)}
            />
          </div>
        </div>
        <SampleDataSelect
          samples={[{ label: t("addData.wmts.sampleLabel"), value: { url: DEFAULT_WMTS_URL } }]}
          onSelect={applyFields}
        />
      </div>
    </AddDataSourceForm>
  );
}
