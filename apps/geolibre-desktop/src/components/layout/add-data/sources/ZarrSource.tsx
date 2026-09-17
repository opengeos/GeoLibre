import { Input, Label, Select } from "@geolibre/ui";
import { VECTOR_COLOR_RAMPS } from "@geolibre/core";
import { addZarrRasterLayer } from "@geolibre/plugins";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { createAppAPI } from "../../../../hooks/usePlugins";
import { AddDataSourceForm, useAddDataSource } from "../shared";

export function ZarrSource() {
  const { t } = useTranslation();
  const source = useAddDataSource(t("toolbar.item.zarrLayer"));
  const [url, setUrl] = useState("");
  const [variable, setVariable] = useState("");
  const [min, setMin] = useState("0"),
    [max, setMax] = useState("1");
  const [colormap, setColormap] = useState("viridis");
  const submit = source.runSubmit(async () => {
    let address: URL;
    try {
      address = new URL(url.trim());
    } catch {
      throw new Error(t("addData.zarr.errorUrl"));
    }
    if (!["http:", "https:"].includes(address.protocol))
      throw new Error(t("addData.zarr.errorUrl"));
    if (!min.trim() || !max.trim()) throw new Error(t("addData.zarr.errorColorLimits"));
    const clim: [number, number] = [Number(min), Number(max)];
    if (!clim.every(Number.isFinite) || clim[1] <= clim[0])
      throw new Error(t("addData.zarr.errorColorLimits"));
    await addZarrRasterLayer(createAppAPI(source.shell.mapControllerRef), {
      url: address.href,
      variable: variable.trim(),
      name: source.layerName,
      clim,
      colormap,
      beforeLayerId: source.beforeLayer,
    });
    source.shell.closeDialog();
  });
  return (
    <AddDataSourceForm
      layerName={source.layerName}
      onLayerNameChange={source.setLayerName}
      beforeLayerId={source.beforeLayerId}
      onBeforeLayerIdChange={source.setBeforeLayerId}
      onSubmit={submit}
      error={source.error}
      submitDisabled={
        source.isSubmitting || !url.trim() || !variable.trim() || !min.trim() || !max.trim()
      }
    >
      <div className="space-y-1.5">
        <Label htmlFor="zarr-url">{t("toolbar.item.urlLabel")}</Label>
        <Input
          id="zarr-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/data.zarr"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="zarr-variable">{t("addData.netcdf.variableLabel")}</Label>
        <Input id="zarr-variable" value={variable} onChange={(e) => setVariable(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="zarr-min">{t("netcdfSymbology.colorMin")}</Label>
          <Input id="zarr-min" type="number" value={min} onChange={(e) => setMin(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="zarr-max">{t("netcdfSymbology.colorMax")}</Label>
          <Input id="zarr-max" type="number" value={max} onChange={(e) => setMax(e.target.value)} />
        </div>
      </div>
      <div>
        <Label htmlFor="zarr-colormap">{t("addData.netcdf.colormapLabel")}</Label>
        <Select id="zarr-colormap" value={colormap} onChange={(e) => setColormap(e.target.value)}>
          {VECTOR_COLOR_RAMPS.map((ramp) => (
            <option key={ramp.value} value={ramp.value}>
              {ramp.label}
            </option>
          ))}
        </Select>
      </div>
    </AddDataSourceForm>
  );
}
