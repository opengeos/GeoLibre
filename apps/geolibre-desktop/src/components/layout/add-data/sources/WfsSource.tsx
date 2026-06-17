import { Input, Label, Select } from "@geolibre/ui";
import { useState } from "react";
import {
  createWfsGetFeatureUrl,
  fetchGeoJsonFeatureCollection,
} from "../../../../lib/layer-refresh";
import { DEFAULT_WFS_ENDPOINT, DEFAULT_WFS_TYPE_NAME } from "../constants";
import { createBaseLayer, parseOptionalNumber } from "../helpers";
import { ServiceLibrarySection } from "../ServiceLibrarySection";
import {
  serviceFieldString,
  type ServiceFields,
} from "../service-library";
import { AddDataSourceForm, useAddDataSource } from "../shared";

export function WfsSource() {
  const source = useAddDataSource("WFS Layer");
  const [wfsEndpoint, setWfsEndpoint] = useState(DEFAULT_WFS_ENDPOINT);
  const [wfsTypeName, setWfsTypeName] = useState(DEFAULT_WFS_TYPE_NAME);
  const [wfsVersion, setWfsVersion] = useState("2.0.0");
  const [wfsOutputFormat, setWfsOutputFormat] = useState("application/json");
  const [wfsSrsName, setWfsSrsName] = useState("EPSG:4326");
  const [wfsMaxFeatures, setWfsMaxFeatures] = useState("1000");

  const getFields = (): ServiceFields => ({
    endpoint: wfsEndpoint,
    typeName: wfsTypeName,
    version: wfsVersion,
    outputFormat: wfsOutputFormat,
    srsName: wfsSrsName,
    maxFeatures: wfsMaxFeatures,
  });

  const applyFields = (fields: ServiceFields) => {
    setWfsEndpoint(serviceFieldString(fields, "endpoint", DEFAULT_WFS_ENDPOINT));
    setWfsTypeName(serviceFieldString(fields, "typeName", DEFAULT_WFS_TYPE_NAME));
    setWfsVersion(serviceFieldString(fields, "version", "2.0.0"));
    setWfsOutputFormat(
      serviceFieldString(fields, "outputFormat", "application/json"),
    );
    setWfsSrsName(serviceFieldString(fields, "srsName", "EPSG:4326"));
    setWfsMaxFeatures(serviceFieldString(fields, "maxFeatures", "1000"));
  };

  const handleSubmit = source.runSubmit(async () => {
    const name = source.layerName.trim() || "WFS Layer";
    if (!wfsEndpoint.trim()) throw new Error("Enter a WFS service URL.");
    if (!wfsTypeName.trim()) {
      throw new Error("Enter a WFS feature type name.");
    }
    if (!wfsOutputFormat.trim()) {
      throw new Error("Enter a WFS output format.");
    }
    parseOptionalNumber(wfsMaxFeatures, "max features");

    const featureUrl = createWfsGetFeatureUrl({
      endpoint: wfsEndpoint.trim(),
      typeName: wfsTypeName.trim(),
      version: wfsVersion,
      outputFormat: wfsOutputFormat.trim(),
      srsName: wfsSrsName.trim(),
      maxFeatures: wfsMaxFeatures.trim() || undefined,
    });
    const data = await fetchGeoJsonFeatureCollection(featureUrl, {
      useWfsProxy: true,
    });
    source.addAndClose(
      {
        ...createBaseLayer(
          name,
          "geojson",
          {
            type: "geojson",
            url: featureUrl,
            service: "wfs",
            typeName: wfsTypeName.trim(),
            version: wfsVersion,
            outputFormat: wfsOutputFormat.trim(),
            srsName: wfsSrsName.trim() || undefined,
          },
          {
            featureCount: data.features.length,
            service: "wfs",
            sourceKind: "wfs-getfeature",
            typeName: wfsTypeName.trim(),
          },
        ),
        geojson: data,
        sourcePath: featureUrl,
      },
      { fit: true },
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
          kind="wfs"
          layerName={source.layerName}
          getFields={getFields}
          onApply={(entry) => {
            source.setLayerName(entry.name);
            applyFields(entry.fields);
          }}
        />
        <div className="space-y-1.5">
          <Label htmlFor="wfs-endpoint">Service URL</Label>
          <Input
            id="wfs-endpoint"
            placeholder="https://example.com/geoserver/wfs"
            value={wfsEndpoint}
            onChange={(event) => setWfsEndpoint(event.target.value)}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="wfs-type-name">Feature type</Label>
            <Input
              id="wfs-type-name"
              placeholder="workspace:layer"
              value={wfsTypeName}
              onChange={(event) => setWfsTypeName(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wfs-version">Version</Label>
            <Select
              id="wfs-version"
              value={wfsVersion}
              onChange={(event) => setWfsVersion(event.target.value)}
            >
              <option value="2.0.0">2.0.0</option>
              <option value="1.1.0">1.1.0</option>
              <option value="1.0.0">1.0.0</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wfs-output-format">Output format</Label>
            <Input
              id="wfs-output-format"
              value={wfsOutputFormat}
              onChange={(event) => setWfsOutputFormat(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wfs-srs-name">SRS name</Label>
            <Input
              id="wfs-srs-name"
              placeholder="Optional"
              value={wfsSrsName}
              onChange={(event) => setWfsSrsName(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wfs-max-features">Max features</Label>
            <Input
              id="wfs-max-features"
              inputMode="numeric"
              placeholder="Optional"
              value={wfsMaxFeatures}
              onChange={(event) => setWfsMaxFeatures(event.target.value)}
            />
          </div>
        </div>
      </div>
    </AddDataSourceForm>
  );
}
