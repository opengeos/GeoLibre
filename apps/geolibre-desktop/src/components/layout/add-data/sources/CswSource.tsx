import { Button, Input, Label } from "@geolibre/ui";
import { ExternalLink, Loader2, Search } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CSW_SAMPLES } from "../constants";
import { createBaseLayer } from "../helpers";
import { openAddData } from "../open-add-data";
import { ServiceLibrarySection } from "../ServiceLibrarySection";
import { serviceFieldString, type ServiceLibraryEntry } from "../service-library";
import { AddDataError, SampleDataSelect, useAddDataSource } from "../shared";
import {
  fetchCswGeoJson,
  isCswFeatureCollection,
  isHttpCswEndpoint,
  searchCsw,
  type CswRecord,
  type CswResource,
} from "../csw";

/** Display casing for resource buttons; `kind.toUpperCase()` would render
 * "ARCGIS"/"GEOJSON" instead of the casing used elsewhere in the UI. */
const RESOURCE_LABEL: Record<CswResource["kind"], string> = {
  wms: "WMS",
  wfs: "WFS",
  arcgis: "ArcGIS",
  geojson: "GeoJSON",
  unknown: "",
};

export function CswSource({
  initialUrl = "",
  initialKeyword = "",
}: {
  initialUrl?: string;
  initialKeyword?: string;
}) {
  const { t } = useTranslation();
  const source = useAddDataSource(t("addData.csw.defaultName"));
  const [endpoint, setEndpoint] = useState(initialUrl);
  const [keyword, setKeyword] = useState(initialKeyword);
  const [records, setRecords] = useState<CswRecord[]>([]);
  // The endpoint these records came from. Results are only shown (and only
  // recorded as a layer's catalog) while it still matches the field, so an
  // edited endpoint can never leave another catalog's resources addable.
  const [recordsEndpoint, setRecordsEndpoint] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const searchAbortRef = useRef<AbortController | null>(null);

  // A response that arrives after the form moved on must not repopulate the
  // list, so abandon the request when the source unmounts.
  useEffect(() => () => searchAbortRef.current?.abort(), []);

  // Abandon a request still in flight. An aborted search skips the spinner reset
  // in its own `finally` (so it cannot clear a spinner a newer search turned
  // on), which leaves this the only place that clears it when nothing replaces
  // the abandoned request.
  const abortSearch = () => {
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    setIsSearching(false);
  };

  // Points the form at another catalog. The results on screen belong to the
  // previous one and their resource URLs would still be addable, so drop them —
  // and any search still in flight for that catalog — until the new endpoint is
  // searched.
  const applyCatalog = (next: { endpoint: string; keyword: string }) => {
    setEndpoint(next.endpoint);
    setKeyword(next.keyword);
    abortSearch();
    setRecords([]);
    setRecordsEndpoint("");
    source.setError(null);
  };

  const applySaved = (entry: ServiceLibraryEntry) => {
    applyCatalog({
      endpoint: serviceFieldString(entry.fields, "endpoint"),
      keyword: serviceFieldString(entry.fields, "keyword"),
    });
  };

  const handleSearch = async (event: FormEvent) => {
    event.preventDefault();
    source.setError(null);
    const target = endpoint.trim();
    // Whatever the previous search was about to return is now stale.
    abortSearch();
    setRecords([]);
    setRecordsEndpoint("");
    if (!isHttpCswEndpoint(target)) {
      source.setError(t("addData.csw.errorUrl"));
      return;
    }
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setIsSearching(true);
    try {
      const next = await searchCsw(target, keyword, controller.signal);
      if (controller.signal.aborted) return;
      setRecords(next);
      setRecordsEndpoint(target);
      if (next.length === 0) source.setError(t("addData.csw.noResults"));
    } catch (error) {
      if (controller.signal.aborted) return;
      source.setError(error instanceof Error ? error.message : t("addData.csw.searchError"));
      setRecords([]);
    } finally {
      // A superseded search must not clear the spinner the newer one turned on.
      if (!controller.signal.aborted) setIsSearching(false);
    }
  };

  const addResource = async (record: CswRecord, resource: CswResource) => {
    source.setError(null);
    if (resource.kind === "geojson") {
      try {
        const geojson = await fetchCswGeoJson(resource.url);
        if (!isCswFeatureCollection(geojson)) throw new Error(t("addData.csw.invalidGeoJson"));
        source.addAndClose(
          {
            ...createBaseLayer(
              record.title,
              "geojson",
              { type: "geojson", data: geojson },
              {
                sourceKind: "csw",
                catalogUrl: recordsEndpoint,
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
      // ArcGISSource has no layer prop — its equivalent field takes numeric
      // sublayer ids, not the catalog's human-readable resource name — so only
      // WMS/WFS get the layer hint.
      const layer = kind === "arcgis" ? undefined : resource.name;
      // Closing clears the shell's target group (no layer was added yet), so
      // carry it into the reopened dialog or an "Add data to group" session
      // would silently drop the layer outside the group.
      const groupId = source.shell.targetGroupId ?? undefined;
      // Close first so the dialog remounts on the new kind, then reopen on the
      // next tick: openAddData sets the kind through the same shell state the
      // close is clearing, and a same-tick call would be overwritten.
      source.shell.closeDialog();
      window.setTimeout(() => openAddData(kind, { url: resource.url, layer, groupId }), 0);
    }
  };

  // Typing a new endpoint without searching leaves the old results on screen;
  // they describe a catalog the form no longer points at, so hide them.
  const visibleRecords = recordsEndpoint === endpoint.trim() ? records : [];

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
      {visibleRecords.length > 0 ? (
        <div className="max-h-80 space-y-2 overflow-y-auto" aria-label={t("addData.csw.results")}>
          {visibleRecords.map((record) => (
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
                      {t("addData.csw.addResource", { kind: RESOURCE_LABEL[resource.kind] })}
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
      <SampleDataSelect
        samples={CSW_SAMPLES.map((sample) => ({
          label: sample.label,
          value: { endpoint: sample.endpoint, keyword: sample.keyword },
        }))}
        onSelect={applyCatalog}
      />
      <div className="flex justify-end">
        <Button type="button" variant="outline" onClick={source.shell.closeDialog}>
          {t("common.close")}
        </Button>
      </div>
    </form>
  );
}
