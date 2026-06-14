import { Button, Input, Label, Select } from "@geolibre/ui";
import { useEffect, useState } from "react";
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
  const source = useAddDataSource("PostgreSQL Layer");
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
        throw new Error("PostgreSQL layers require GeoLibre Desktop.");
      }
      if (!postgresConnectionString.trim()) {
        throw new Error("Enter a PostgreSQL connection string.");
      }
      const connectionString = postgresConnectionString.trim();

      martin.setStatus("Checking Martin binary...");
      const binary = await ensureMartinBinary();
      martin.setStatus(
        binary.downloaded
          ? "Martin downloaded. Starting local server..."
          : "Starting local Martin server...",
      );
      const server = await startMartinServer({
        connectionString,
        defaultSrid: postgresDefaultSrid,
      });
      setSavedPostgresConnections(rememberPostgresConnection(connectionString));
      martin.setServer(server);
      martin.setStatus("Reading Martin catalog...");

      const sources = await fetchMartinCatalog(server);
      martin.setSources(sources);
      martin.setSelectedSourceId(sources[0]?.id ?? "");
      martin.setStatus(
        sources.length > 0
          ? `Found ${sources.length} source${sources.length === 1 ? "" : "s"}.`
          : "Martin is running, but no compatible PostGIS sources were found.",
      );
    } catch (err) {
      martin.setServer(null);
      source.setError(errorMessage(err, "Could not connect to PostgreSQL."));
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
      martin.layerAddedRef.current = false;
      martin.setServer(null);
      martin.setSources([]);
      martin.setSelectedSourceId("");
      martin.setStatus("Martin stopped.");
    } catch (err) {
      source.setError(errorMessage(err, "Could not stop Martin."));
    } finally {
      source.shell.setIsSubmitting(false);
    }
  };

  const addMartinSource = async (sourceId: string) => {
    const server = martin.server;
    if (!server) throw new Error("Connect to PostgreSQL first.");
    const tilejson = await fetchMartinTileJson(server, sourceId);
    const vectorLayers = tilejson.vector_layers ?? tilejson.vectorLayers ?? [];
    const sourceLayer = vectorLayers[0]?.id;
    if (!sourceLayer) {
      throw new Error("The selected Martin source has no vector layers.");
    }

    const summary = martin.sources.find(
      (candidate) => candidate.id === sourceId,
    );
    const tilejsonUrl = martinTileJsonUrl(server, sourceId);
    martin.layerAddedRef.current = true;
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
      throw new Error("Connect to PostgreSQL first.");
    }
    if (!martin.selectedSourceId) {
      throw new Error("Select a Martin source to add.");
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
            PostgreSQL layers are only available in GeoLibre Desktop. This
            feature runs a local Martin tile server, which the web app cannot
            launch.
          </p>
        ) : null}
        {savedPostgresConnections.length > 0 ? (
          <div className="space-y-1.5">
            <Label htmlFor="postgres-saved-connection">Saved connection</Label>
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
              <option value="">Select saved connection</option>
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
            PostgreSQL connection string
          </Label>
          <Input
            id="postgres-connection"
            type="password"
            autoComplete="off"
            placeholder="postgres://user:password@host:5432/database"
            value={postgresConnectionString}
            onChange={(event) =>
              setPostgresConnectionString(event.target.value)
            }
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <div className="space-y-1.5">
            <Label htmlFor="postgres-default-srid">Default SRID</Label>
            <Input
              id="postgres-default-srid"
              inputMode="numeric"
              placeholder="Optional"
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
                Connect
              </Button>
              {martin.server ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleStopMartin}
                  disabled={source.isSubmitting}
                >
                  Stop
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
            <Label htmlFor="martin-source">Martin source</Label>
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
            Martin is running on port {martin.server.port}.
          </p>
        ) : null}
      </div>
    </AddDataSourceForm>
  );
}
