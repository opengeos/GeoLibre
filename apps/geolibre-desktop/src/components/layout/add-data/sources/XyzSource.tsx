import { Input, Label } from "@geolibre/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  createXyzTileUrlTemplate,
  registerXyzTileProtocol,
  resolveXyzTileUrlTemplate,
} from "../../../../lib/xyz-url";
import { buildXyzLayer } from "../apply-service";
import { DEFAULT_XYZ_URL } from "../constants";
import { ServiceLibrarySection } from "../ServiceLibrarySection";
import { serviceFieldBoolean, serviceFieldString, type ServiceFields } from "../service-library";
import { AddDataSourceForm, SampleDataSelect, useAddDataSource } from "../shared";

export function XyzSource() {
  const { t } = useTranslation();
  const source = useAddDataSource(t("addData.xyz.defaultName"));
  const [xyzUrl, setXyzUrl] = useState("");
  const [xyzTileSize, setXyzTileSize] = useState("256");
  const [xyzShortUrl, setXyzShortUrl] = useState(false);

  const getFields = (): ServiceFields => ({
    url: xyzUrl,
    tileSize: xyzTileSize,
    shortUrl: xyzShortUrl,
  });

  const applyFields = (fields: ServiceFields) => {
    setXyzUrl(serviceFieldString(fields, "url"));
    setXyzTileSize(serviceFieldString(fields, "tileSize", "256"));
    setXyzShortUrl(serviceFieldBoolean(fields, "shortUrl", false));
  };

  const handleSubmit = source.runSubmit(async () => {
    const name = source.layerName.trim() || t("addData.xyz.defaultName");
    if (!xyzUrl.trim()) throw new Error(t("addData.xyz.errorUrl"));
    if (xyzShortUrl) registerXyzTileProtocol();
    const tileUrl = xyzShortUrl
      ? await resolveXyzTileUrlTemplate(xyzUrl)
      : createXyzTileUrlTemplate(xyzUrl);
    source.addAndClose(
      buildXyzLayer({
        name,
        tileUrl,
        tileSize: xyzTileSize,
        shortUrl: xyzShortUrl,
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
            <Label htmlFor="xyz-url">{t("addData.common.tileUrlTemplate")}</Label>
            <Input
              id="xyz-url"
              placeholder={
                xyzShortUrl ? t("addData.xyz.shortUrlPlaceholder") : t("addData.xyz.urlPlaceholder")
              }
              value={xyzUrl}
              onChange={(event) => setXyzUrl(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="xyz-tile-size">{t("addData.common.tileSize")}</Label>
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
          {t("addData.xyz.shortUrl")}
        </label>
        <SampleDataSelect
          samples={[{ label: t("addData.xyz.sampleLabel"), value: { url: DEFAULT_XYZ_URL } }]}
          onSelect={applyFields}
        />
      </div>
    </AddDataSourceForm>
  );
}
