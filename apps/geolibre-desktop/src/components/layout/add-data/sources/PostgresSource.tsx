import { Button, Input, Label, Select } from "@geolibre/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ensureMartinBinary,
  fetchMartinCatalog,
  fetchMartinTileJson,
  martinTileJsonUrl,
  startMartinServer,
  stopMartinServer,
} from "../../../../lib/martin";
import { isTauri } from "../../../../lib/tauri-io";
import {
  createBaseLayer,
  errorMessage,
  readSavedPostgresConnections,
  rememberPostgresConnection,
  savedPostgresConnectionLabel,
} from "../helpers";
import { AddDataSourceForm, useAddDataSource } from "../shared";

export function PostgresSource() {
  const { t } = useTranslation();
  const source = useAddDataSource(t("addData.postgres.defaultName"));
  const { martin } = source.shell;
  const [postgresConnectionString, setPostgresConnectionString] = useState(
    () => readSavedPostgresConnections()[0] ?? "",
  );
  const [savedPostgresConnections, setSavedPostgresConnections] = useState(() =>
    readSavedPostgresConnections(),
  );
  const [postgresDefaultSrid, setPostgresDefaultSrid] = useState("");

  // Reset the (shell-owned) Martin connection when the source opens, matching
  // the original dialog: a running server is preserved across reopens only
  // after a layer was added.
  useEffect(() => {
    martin.resetOnOpen();
    // Mount-only: `martin` is intentionally excluded from the deps — re-running
    // resetOnOpen on every render would clear connection state mid-flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConnectPostgres = async () => {
    source.setError(null);
    martin.setStatus(null);
    source.shell.setIsSubmitting(true);
    martin.setSources([]);
    martin.setSelectedSourceId("");

    try {
      if (!isTauri()) {
        throw new Error(t("addData.postgres.errorDesktopOnly"));
      }
      if (!postgresConnectionString.trim()) {
        throw new Error(t("addData.postgres.errorConnectionString"));
      }
      const connectionString = postgresConnectionString.trim();

      martin.setStatus(t("addData.postgres.statusCheckingBinary"));
      const binary = await ensureMartinBinary();
      martin.setStatus(
        binary.downloaded
          ? t("addData.postgres.statusDownloaded")
          : t("addData.postgres.statusStarting"),
      );
      const server = await startMartinServer({
        connectionString,
        defaultSrid: postgresDefaultSrid,
      });
      setSavedPostgresConnections(rememberPostgresConnection(connectionString));
      martin.setServer(server);
      martin.setStatus(t("addData.postgres.statusReadingCatalog"));

      const sources = await fetchMartinCatalog(server);
      martin.setSources(sources);
      martin.setSelectedSourceId(sources[0]?.id ?? "");
      martin.setStatus(
        sources.length > 0
          ? t("addData.postgres.statusFound", { count: sources.length })
          : t("addData.postgres.statusNoSources"),
      );
    } catch (err) {
      martin.setServer(null);
      source.setError(
        errorMessage(err, t("addData.postgres.errorConnect")),
      );
      martin.setStatus(null);
    } finally {
      source.shell.setIsSubmitting(false);
    }
  };

  const handleStopMartin = async () => {
    source.setError(null);
    source.shell.setIsSubmitting(true);
    try {
      await stopMartinServer();
      martin.setServer(null);
      martin.setSources([]);
      martin.setSelectedSourceId("");
      martin.setStatus(t("addData.postgres.statusStopped"));
    } catch (err) {
      source.setError(errorMessage(err, t("addData.postgres.errorStop")));
    } finally {
      source.shell.setIsSubmitting(false);
    }
  };

  const addMartinSource = async (sourceId: string) => {
    const server = martin.server;
    if (!server) throw new Error(t("addData.postgres.errorConnectFirst"));
    const tilejson = await fetchMartinTileJson(server, sourceId);
    const vectorLayers = tilejson.vector_layers ?? tilejson.vectorLayers ?? [];
    const sourceLayer = vectorLayers[0]?.id;
    if (!sourceLayer) {
      throw new Error(t("addData.postgres.errorNoVectorLayers"));
    }

    const summary = martin.sources.find(
      (candidate) => candidate.id === sourceId,
    );
    const tilejsonUrl = martinTileJsonUrl(server, sourceId);
    martin.markLayerAdded();
    source.addAndClose(
      createBaseLayer(
        source.layerName.trim() ||
          tilejson.name ||
          summary?.name ||
          sourceId,
        "vector-tiles",
        {
          type: "vector",
          url: tilejsonUrl,
          sourceLayer,
          sourceLayers: vectorLayers.map((vectorLayer) => vectorLayer.id),
          bounds: tilejson.bounds,
          minzoom: tilejson.minzoom,
          maxzoom: tilejson.maxzoom,
        },
        {
          bounds: tilejson.bounds,
          center: tilejson.center,
          maxzoom: tilejson.maxzoom,
          minzoom: tilejson.minzoom,
          martinPort: server.port,
          martinSourceId: sourceId,
          sourceKind: "martin-postgis",
          sourceLayers: vectorLayers.map((vectorLayer) => vectorLayer.id),
          tilejsonUrl,
        },
      ),
      { fit: true },
    );
  };

  const handleSubmit = source.runSubmit(async () => {
    if (!martin.server) {
      throw new Error(t("addData.postgres.errorConnectFirst"));
    }
    if (!martin.selectedSourceId) {
      throw new Error(t("addData.postgres.errorSelectSource"));
    }
    await addMartinSource(martin.selectedSourceId);
  });

  return (
    <AddDataSourceForm
      layerName={source.layerName}
      onLayerNameChange={source.setLayerName}
      beforeLayerId={source.beforeLayerId}
      onBeforeLayerIdChange={source.setBeforeLayerId}
      onSubmit={handleSubmit}
      error={source.error}
      submitDisabled={
        source.isSubmitting || !martin.server || !martin.selectedSourceId
      }
    >
      <div className="space-y-3">
        {!isTauri() ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {t("addData.postgres.desktopOnlyNotice")}
          </p>
        ) : null}
        {savedPostgresConnections.length > 0 ? (
          <div className="space-y-1.5">
            <Label htmlFor="postgres-saved-connection">
              {t("addData.postgres.savedConnection")}
            </Label>
            <Select
              id="postgres-saved-connection"
              value={
                savedPostgresConnections.includes(postgresConnectionString)
                  ? postgresConnectionString
                  : ""
              }
              onChange={(event) =>
                setPostgresConnectionString(event.target.value)
              }
            >
              <option value="">
                {t("addData.postgres.selectSavedConnection")}
              </option>
              {savedPostgresConnections.map((connection) => (
                <option key={connection} value={connection}>
                  {savedPostgresConnectionLabel(connection)}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor="postgres-connection">
            {t("addData.postgres.connectionString")}
          </Label>
          <Input
            id="postgres-connection"
            type="password"
            autoComplete="off"
            placeholder={t("addData.postgres.connectionStringPlaceholder")}
            value={postgresConnectionString}
            onChange={(event) =>
              setPostgresConnectionString(event.target.value)
            }
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <div className="space-y-1.5">
            <Label htmlFor="postgres-default-srid">
              {t("addData.postgres.defaultSrid")}
            </Label>
            <Input
              id="postgres-default-srid"
              inputMode="numeric"
              placeholder={t("addData.common.optional")}
              value={postgresDefaultSrid}
              onChange={(event) => setPostgresDefaultSrid(event.target.value)}
            />
          </div>
          <div className="flex items-end">
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={handleConnectPostgres}
                disabled={source.isSubmitting || !isTauri()}
              >
                {t("addData.postgres.connect")}
              </Button>
              {martin.server ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleStopMartin}
                  disabled={source.isSubmitting}
                >
                  {t("addData.postgres.stop")}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
        {martin.status ? (
          <p className="text-xs text-muted-foreground">{martin.status}</p>
        ) : null}
        {martin.sources.length > 0 ? (
          <div className="space-y-1.5">
            <Label htmlFor="martin-source">
              {t("addData.postgres.martinSource")}
            </Label>
            <Select
              id="martin-source"
              value={martin.selectedSourceId}
              onChange={(event) =>
                martin.setSelectedSourceId(event.target.value)
              }
            >
              {martin.sources.map((martinSource) => (
                <option key={martinSource.id} value={martinSource.id}>
                  {martinSource.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        {martin.server ? (
          <p className="text-xs text-muted-foreground">
            {t("addData.postgres.runningOnPort", { port: martin.server.port })}
          </p>
        ) : null}
      </div>
    </AddDataSourceForm>
  );
}
