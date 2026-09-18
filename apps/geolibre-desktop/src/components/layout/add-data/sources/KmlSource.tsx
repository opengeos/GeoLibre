import { createCesiumKmlLayer, useAppStore } from "@geolibre/core";
import { routeKmlFileSelection } from "@geolibre/plugins";
import { Button, Input, Label } from "@geolibre/ui";
import { useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { isTauri } from "../../../../lib/is-tauri";
import {
  kmlFileNameFromUrl,
  kmlImportFile,
  kmlMapImports,
  type PickedKmlDocument,
} from "../../../../lib/kml-import-file";
import { openLocalDataFileWithFallback } from "../../../../lib/tauri-io";
import {
  errorMessage,
  fileNameFromPath,
  layerNameFromPath,
  proxyFeedRequestUrl,
  serviceRequestErrorMessage,
} from "../helpers";
import { AddDataSourceForm, useAddDataSource } from "../shared";

/** Download budget for a whole KML/KMZ document (matches the vector loader's). */
const KML_DOWNLOAD_TIMEOUT_SECS = 180;

/** Encodes a picked KMZ archive as the data URL a Cesium KML layer persists. */
function kmzDataUrl(data: ArrayBuffer): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([data], { type: "application/vnd.google-earth.kmz" }));
  });
}

/**
 * Downloads a KML/KMZ URL for the 2D importer. The desktop fetches natively
 * (no CORS); the dev server goes through its same-origin proxy; the hosted web
 * build needs the host to allow cross-origin reads.
 */
async function fetchKmlImportFile(url: string, t: TFunction): Promise<File> {
  let bytes: Uint8Array;
  if (isTauri()) {
    try {
      const { fetchUrlBytes } = await import("../../../../lib/native-http");
      // The native default timeout suits a tile; a whole document (possibly
      // with embedded overlay imagery) needs the vector-download budget.
      const raw = await fetchUrlBytes(url, {
        context: "KML / KMZ",
        timeoutSecs: KML_DOWNLOAD_TIMEOUT_SECS,
      });
      bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    } catch (error) {
      throw new Error(serviceRequestErrorMessage(error, t, t("addData.shared.addError")));
    }
  } else {
    let response: Response;
    try {
      response = await fetch(proxyFeedRequestUrl(url), {
        signal: AbortSignal.timeout(KML_DOWNLOAD_TIMEOUT_SECS * 1000),
      });
    } catch (error) {
      // A CORS block or a timeout surfaces as an opaque TypeError/AbortError;
      // map it to the localized hint the other service sources show.
      throw new Error(serviceRequestErrorMessage(error, t, t("addData.shared.addError")));
    }
    if (!response.ok) {
      throw new Error(t("addData.common.requestFailed", { status: response.status }));
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  return kmlImportFile(kmlFileNameFromUrl(url, bytes), bytes);
}

/**
 * KML / KMZ from a URL or a local file. On the Cesium globe the document is
 * preserved as a native `KmlDataSource` layer (styles, overlays, network
 * links). On the 2D renderers it goes through the host KML importer that
 * drag-and-drop and the Browser panel use, which converts placemarks into
 * folder-aware GeoJSON layers and adds ground overlays, models, and
 * Super-Overlays; layer names then come from the document itself.
 */
export function KmlSource({ initialUrl }: { initialUrl?: string }) {
  const { t } = useTranslation();
  const nativeGlobe = useAppStore((state) => state.primaryRenderer === "cesium");
  const [defaultName] = useState(() => t("addData.kml.defaultName"));
  const source = useAddDataSource(defaultName);
  const [url, setUrl] = useState(initialUrl ?? "");
  const [picked, setPicked] = useState<PickedKmlDocument | null>(null);
  const chooseFile = async () => {
    source.setError(null);
    try {
      const file = await openLocalDataFileWithFallback({
        filters: [{ name: "KML / KMZ", extensions: ["kml", "kmz"] }],
        accept: ".kml,.kmz",
        readText: true,
        binaryExtensions: ["kmz"],
      });
      if (!file) return;
      if (!file.data?.byteLength && !file.text?.trim()) {
        throw new Error(t("addData.kml.errorSource"));
      }
      setPicked(file);
      setUrl("");
      source.setLayerName((current) =>
        current.trim() && current !== defaultName
          ? current
          : layerNameFromPath(file.path, defaultName),
      );
    } catch (error) {
      source.setError(errorMessage(error, t("addData.shared.addError")));
    }
  };
  const submit = source.runSubmit(async () => {
    const trimmedUrl = url.trim();
    if (!picked && !trimmedUrl) throw new Error(t("addData.kml.errorSource"));
    if (nativeGlobe) {
      const data = picked ? (picked.data ? await kmzDataUrl(picked.data) : picked.text) : undefined;
      source.addAndClose(
        createCesiumKmlLayer({
          name: source.layerName.trim() || defaultName,
          url: trimmedUrl,
          data,
          sourcePath: picked?.path,
        }),
      );
      return;
    }
    const imports = await kmlMapImports(picked, trimmedUrl, {
      // Only a native pick has a filesystem path the importer may re-read.
      nativePath: isTauri(),
      fileName: fileNameFromPath,
      fetchFile: (target) => fetchKmlImportFile(target, t),
    });
    // The host importer reports its own failures through the shell's import
    // banner; a `false` here means no importer is registered at all.
    if (!(await routeKmlFileSelection(imports))) {
      throw new Error(t("addData.kml.errorImporter"));
    }
    source.shell.closeDialog();
  });
  return (
    <AddDataSourceForm
      layerName={source.layerName}
      onLayerNameChange={source.setLayerName}
      beforeLayerId={source.beforeLayerId}
      onBeforeLayerIdChange={source.setBeforeLayerId}
      hideLayerFields={!nativeGlobe}
      onSubmit={submit}
      error={source.error}
      submitDisabled={source.isSubmitting}
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="kml-url">{t("addData.kml.url")}</Label>
          <Input
            id="kml-url"
            value={url}
            placeholder="https://example.com/map.kmz"
            onChange={(event) => {
              setUrl(event.target.value);
              setPicked(null);
            }}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" onClick={chooseFile}>
            {t("addData.common.chooseFile")}
          </Button>
          <span className="truncate text-xs text-muted-foreground">
            {picked?.path ?? t("addData.common.noFileSelected")}
          </span>
        </div>
        {!nativeGlobe && (
          <p className="text-xs text-muted-foreground">{t("addData.kml.mapLayerNamesNote")}</p>
        )}
      </div>
    </AddDataSourceForm>
  );
}
