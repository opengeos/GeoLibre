import { Button, Input, Label } from "@geolibre/ui";
import { ExternalLink, Loader2, Search } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { createBaseLayer } from "../helpers";
import { openAddData } from "../open-add-data";
import { ServiceLibrarySection } from "../ServiceLibrarySection";
import { serviceFieldString, type ServiceLibraryEntry } from "../service-library";
import { AddDataError, useAddDataSource } from "../shared";
import { searchCsw, type CswRecord, type CswResource } from "../csw";

export function CswSource({ initialUrl = "" }: { initialUrl?: string }) {
  const { t } = useTranslation();
  const source = useAddDataSource(t("addData.csw.defaultName"));
  const [endpoint, setEndpoint] = useState(initialUrl);
  const [keyword, setKeyword] = useState("");
  const [records, setRecords] = useState<CswRecord[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const applySaved = (entry: ServiceLibraryEntry) => {
    setEndpoint(serviceFieldString(entry.fields, "endpoint"));
    setKeyword(serviceFieldString(entry.fields, "keyword"));
  };

  const handleSearch = async (event: FormEvent) => {
    event.preventDefault();
    source.setError(null);
    if (!/^https?:\/\//i.test(endpoint.trim())) {
      source.setError(t("addData.csw.errorUrl"));
      return;
    }
    setIsSearching(true);
    try {
      const next = await searchCsw(endpoint.trim(), keyword);
      setRecords(next);
      if (next.length === 0) source.setError(t("addData.csw.noResults"));
    } catch (error) {
      source.setError(error instanceof Error ? error.message : t("addData.csw.searchError"));
      setRecords([]);
    } finally {
      setIsSearching(false);
    }
  };

  const addResource = async (record: CswRecord, resource: CswResource) => {
    source.setError(null);
    if (resource.kind === "geojson") {
      try {
        const response = await fetch(resource.url);
        if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
        const geojson = (await response.json()) as GeoJSON.FeatureCollection;
        if (geojson.type !== "FeatureCollection") throw new Error(t("addData.csw.invalidGeoJson"));
        source.addAndClose(
          {
            ...createBaseLayer(
              record.title,
              "geojson",
              { type: "geojson", data: geojson },
              {
                sourceKind: "csw",
                catalogUrl: endpoint,
              },
              { geojson },
            ),
            geojson,
            sourcePath: resource.url,
          },
          { fit: true },
        );
      } catch (error) {
        source.setError(error instanceof Error ? error.message : t("addData.csw.addError"));
      }
      return;
    }
    if (resource.kind === "wms" || resource.kind === "wfs" || resource.kind === "arcgis") {
      const kind = resource.kind;
      source.shell.closeDialog();
      window.setTimeout(() => openAddData(kind, { url: resource.url, layer: resource.name }), 0);
    }
  };

  return (
    <form className="space-y-4" onSubmit={handleSearch}>
      <ServiceLibrarySection
        kind="csw"
        layerName={t("addData.csw.defaultName")}
        getFields={() => ({ endpoint, keyword })}
        onApply={applySaved}
      />
      <div className="space-y-1.5">
        <Label htmlFor="csw-endpoint">{t("addData.common.serviceUrl")}</Label>
        <Input
          id="csw-endpoint"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder={t("addData.csw.urlPlaceholder")}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="csw-keyword">{t("addData.csw.keyword")}</Label>
        <div className="flex gap-2">
          <Input id="csw-keyword" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
          <Button type="submit" disabled={isSearching || !endpoint.trim()}>
            {isSearching ? (
              <Loader2 className="me-2 h-4 w-4 animate-spin" />
            ) : (
              <Search className="me-2 h-4 w-4" />
            )}
            {isSearching ? t("addData.csw.searching") : t("addData.csw.search")}
          </Button>
        </div>
      </div>
      {source.error ? <AddDataError message={source.error} /> : null}
      {records.length > 0 ? (
        <div className="max-h-80 space-y-2 overflow-y-auto" aria-label={t("addData.csw.results")}>
          {records.map((record) => (
            <article key={record.identifier} className="space-y-2 rounded-md border p-3">
              <div className="font-medium">{record.title}</div>
              {record.abstract ? (
                <p className="line-clamp-3 text-sm text-muted-foreground">{record.abstract}</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {record.resources
                  .filter((item) => item.kind !== "unknown")
                  .map((resource) => (
                    <Button
                      key={resource.url}
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void addResource(record, resource)}
                    >
                      <ExternalLink className="me-1.5 h-3.5 w-3.5" />
                      {t("addData.csw.addResource", { kind: resource.kind.toUpperCase() })}
                    </Button>
                  ))}
                {record.resources.every((item) => item.kind === "unknown") ? (
                  <span className="text-xs text-muted-foreground">
                    {t("addData.csw.noSupportedResources")}
                  </span>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      ) : null}
      <div className="flex justify-end">
        <Button type="button" variant="outline" onClick={source.shell.closeDialog}>
          {t("common.close")}
        </Button>
      </div>
    </form>
  );
}
