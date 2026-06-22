import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  ScrollArea,
  Select,
} from "@geolibre/ui";
import { OpenEO } from "@openeo/js-client";
import {
  CheckCircle2,
  Download,
  Loader2,
  Play,
  RefreshCw,
  Server,
} from "lucide-react";
import type { TFunction } from "i18next";
import { type FormEvent, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

interface OpenEODialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface OpenEOConnection {
  authenticateBasic(username: string, password: string): Promise<void>;
  buildProcess(id: string): Promise<OpenEOBuilder>;
  capabilities(): OpenEOCapabilities;
  createJob(
    process: unknown,
    title?: string | null,
    description?: string | null,
  ): Promise<OpenEOJob>;
  downloadResult(process: unknown, targetPath: string): Promise<void>;
  listCollections(): Promise<{ collections?: OpenEOCollection[] }>;
  listJobs(): Promise<OpenEOJob[]>;
  listProcesses(): Promise<{ processes?: OpenEOProcess[] }>;
}

interface OpenEOBuilder {
  load_collection(
    collection: string,
    spatialExtent: OpenEOBoundingBox,
    temporalExtent: [string, string],
    bands?: string[],
  ): unknown;
  reduce_dimension(
    data: unknown,
    reducer: (this: OpenEOBuilder, data: unknown) => unknown,
    dimension: string,
  ): unknown;
  save_result(data: unknown, format: string): unknown;
  mean(data: unknown): unknown;
  median(data: unknown): unknown;
  min(data: unknown): unknown;
  max(data: unknown): unknown;
}

interface OpenEOCapabilities {
  apiVersion(): string;
  description(): string;
  links(): Array<{ href?: string; title?: string; rel?: string }>;
  listPlans(): Array<{ name?: string; url?: string }>;
}

interface OpenEOCollection {
  id?: string;
  title?: string;
  summary?: string;
  description?: string;
}

interface OpenEOProcess {
  id?: string;
  summary?: string;
  description?: string;
}

interface OpenEOJob {
  id: string;
  title?: string | null;
  status?: string | null;
  created?: string | null;
  startJob(): Promise<OpenEOJob>;
}

interface OpenEOBoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

type Reducer = "none" | "mean" | "median" | "min" | "max";

type BusyAction = "connect" | "job" | "jobs" | "download";

const DEFAULT_BACKEND_URL = "https://earthengine.openeo.org";
const DEFAULT_COLLECTION = "COPERNICUS/S1_GRD";
const DEFAULT_BANDS = "VV,VH";
const DEFAULT_OUTPUT_FORMAT = "GTiff";
const CONNECT_TIMEOUT_MS = 30_000;
const OPERATION_TIMEOUT_MS = 60_000;
// Synchronous processing can legitimately take several minutes.
const SYNC_RESULT_TIMEOUT_MS = 300_000;
const MAX_LIST_ITEMS = 24;
const MAX_JOB_ITEMS = 20;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
    // NOTE: the underlying request is not cancelled when the timer fires;
    // the resolved/rejected value will be silently discarded.
  });
}

function parseBands(value: string): string[] | undefined {
  const bands = value
    .split(",")
    .map((band) => band.trim())
    .filter(Boolean);
  return bands.length ? bands : undefined;
}

function parseNumber(value: string, label: string, t: TFunction): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(t("openeo.errors.numberRequired", { label }));
  }
  return parsed;
}

function buildBoundingBox(
  values: {
    west: string;
    south: string;
    east: string;
    north: string;
  },
  t: TFunction,
): OpenEOBoundingBox {
  const bbox = {
    west: parseNumber(values.west, t("openeo.west"), t),
    south: parseNumber(values.south, t("openeo.south"), t),
    east: parseNumber(values.east, t("openeo.east"), t),
    north: parseNumber(values.north, t("openeo.north"), t),
  };

  if (bbox.west >= bbox.east) {
    throw new Error(t("openeo.errors.westLessThanEast"));
  }
  if (bbox.south >= bbox.north) {
    throw new Error(t("openeo.errors.southLessThanNorth"));
  }
  if (bbox.west < -180 || bbox.east > 180) {
    throw new Error(t("openeo.errors.longitudeRange"));
  }
  if (bbox.south < -90 || bbox.north > 90) {
    throw new Error(t("openeo.errors.latitudeRange"));
  }
  return bbox;
}

function filterByQuery<T extends { id?: string; title?: string; summary?: string }>(
  values: T[],
  query: string,
): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return values;

  return values.filter((value) =>
    [value.id, value.title, value.summary]
      .filter(Boolean)
      .some((text) => text!.toLowerCase().includes(normalizedQuery)),
  );
}

function formatError(error: unknown, t: TFunction): string {
  if (error instanceof Error) return error.message;
  return t("openeo.errors.requestFailed");
}

function createReducer(reducer: Exclude<Reducer, "none">) {
  // The openEO JS client invokes reducer callbacks with `this` bound to the
  // builder for the sub-process graph.
  return function reducerCallback(this: OpenEOBuilder, data: unknown): unknown {
    if (reducer === "mean") return this.mean(data);
    if (reducer === "median") return this.median(data);
    if (reducer === "min") return this.min(data);
    return this.max(data);
  };
}

export function OpenEODialog({ open, onOpenChange }: OpenEODialogProps) {
  const { t } = useTranslation();
  const [backendUrl, setBackendUrl] = useState(DEFAULT_BACKEND_URL);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [connection, setConnection] = useState<OpenEOConnection | null>(null);
  const [capabilities, setCapabilities] = useState<OpenEOCapabilities | null>(
    null,
  );
  const [collections, setCollections] = useState<OpenEOCollection[]>([]);
  const [processes, setProcesses] = useState<OpenEOProcess[]>([]);
  const [jobs, setJobs] = useState<OpenEOJob[]>([]);
  const [collectionQuery, setCollectionQuery] = useState("");
  const [processQuery, setProcessQuery] = useState("");
  const [selectedCollection, setSelectedCollection] =
    useState(DEFAULT_COLLECTION);
  const [bands, setBands] = useState(DEFAULT_BANDS);
  const [west, setWest] = useState("16.06");
  const [south, setSouth] = useState("48.06");
  const [east, setEast] = useState("16.65");
  const [north, setNorth] = useState("48.35");
  const [startDate, setStartDate] = useState("2017-03-01");
  const [endDate, setEndDate] = useState("2017-04-01");
  const [reducer, setReducer] = useState<Reducer>("mean");
  const [dimension, setDimension] = useState("t");
  const [outputFormat, setOutputFormat] = useState(DEFAULT_OUTPUT_FORMAT);
  const [jobTitle, setJobTitle] = useState(t("openeo.defaultJobTitle"));
  const [startImmediately, setStartImmediately] = useState(true);
  const [downloadFilename, setDownloadFilename] =
    useState("openeo-result.tif");
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const filteredCollections = useMemo(
    () => filterByQuery(collections, collectionQuery),
    [collections, collectionQuery],
  );
  const filteredProcesses = useMemo(
    () => filterByQuery(processes, processQuery),
    [processes, processQuery],
  );
  const visibleCollections = filteredCollections.slice(0, MAX_LIST_ITEMS);
  const visibleProcesses = filteredProcesses.slice(0, MAX_LIST_ITEMS);

  const isBusy = busyAction !== null;

  const resetConnectionState = () => {
    setConnection(null);
    setCapabilities(null);
    setCollections([]);
    setProcesses([]);
    setJobs([]);
    // Clear the search filters too, otherwise stale query text keeps filtering
    // the next backend's (freshly empty) lists and looks like a silent failure.
    setCollectionQuery("");
    setProcessQuery("");
  };

  const handleConnect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const url = backendUrl.trim();
    if (!url) {
      setErrorMessage(t("openeo.errors.enterUrl"));
      return;
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        setErrorMessage(t("openeo.errors.invalidProtocol"));
        return;
      }
      // Basic auth puts the credentials in an `Authorization` header; over plain
      // HTTP that is sent in cleartext. Allow it only for loopback dev backends.
      const isLoopback =
        parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "::1";
      if (authEnabled && parsed.protocol === "http:" && !isLoopback) {
        setErrorMessage(t("openeo.errors.httpBasicAuth"));
        return;
      }
    } catch {
      setErrorMessage(t("openeo.errors.invalidUrl"));
      return;
    }
    if (authEnabled && (!username.trim() || !password)) {
      setErrorMessage(t("openeo.errors.enterCredentials"));
      return;
    }

    setBusyAction("connect");
    setErrorMessage(null);
    setStatusMessage(t("openeo.status.connecting"));
    resetConnectionState();

    try {
      const nextConnection = (await withTimeout(
        OpenEO.connect(url),
        CONNECT_TIMEOUT_MS,
        t("openeo.errors.connectTimeout"),
      )) as unknown as OpenEOConnection;
      if (authEnabled) {
        await nextConnection.authenticateBasic(username.trim(), password);
        // Drop the password from state once it has been exchanged for a token;
        // no need to keep the plaintext credential around for the session.
        setPassword("");
      }
      const nextCapabilities = nextConnection.capabilities();
      setStatusMessage(
        t("openeo.status.connectedApi", {
          version: nextCapabilities.apiVersion() || t("openeo.statusUnknown"),
        }),
      );

      const [collectionResponse, processResponse] = await withTimeout(
        Promise.all([
          nextConnection.listCollections(),
          nextConnection.listProcesses(),
        ]),
        OPERATION_TIMEOUT_MS,
        t("openeo.errors.loadResourcesTimeout"),
      );
      setConnection(nextConnection);
      setCapabilities(nextCapabilities);
      const nextCollections = collectionResponse.collections ?? [];
      const nextProcesses = processResponse.processes ?? [];
      setCollections(nextCollections);
      setProcesses(nextProcesses);
      // Keep the current selection when this backend offers it; otherwise
      // fall back to the backend's first collection.
      const firstCollectionId = nextCollections[0]?.id;
      if (
        firstCollectionId &&
        !nextCollections.some(
          (collection) => collection.id === selectedCollection.trim(),
        )
      ) {
        setSelectedCollection(firstCollectionId);
      }
      setStatusMessage(
        t("openeo.status.connectedLoaded", {
          collections: nextCollections.length,
          processes: nextProcesses.length,
        }),
      );
    } catch (error) {
      setErrorMessage(formatError(error, t));
      setStatusMessage(null);
    } finally {
      setBusyAction(null);
    }
  };

  const buildProcess = async (): Promise<unknown> => {
    if (!connection) throw new Error(t("openeo.errors.connectFirst"));
    if (!selectedCollection.trim()) {
      throw new Error(t("openeo.errors.enterCollectionId"));
    }
    if (!startDate || !endDate) {
      throw new Error(t("openeo.errors.enterDates"));
    }
    if (startDate >= endDate) {
      throw new Error(t("openeo.errors.startBeforeEnd"));
    }

    const bbox = buildBoundingBox({ west, south, east, north }, t);
    const builder = await connection.buildProcess("geolibre-openeo-job");
    let datacube = builder.load_collection(
      selectedCollection.trim(),
      bbox,
      [startDate, endDate],
      parseBands(bands),
    );

    if (reducer !== "none") {
      datacube = builder.reduce_dimension(
        datacube,
        createReducer(reducer),
        dimension.trim() || "t",
      );
    }

    return builder.save_result(datacube, outputFormat.trim() || "GTiff");
  };

  const handleCreateJob = async () => {
    setBusyAction("job");
    setErrorMessage(null);
    setStatusMessage(t("openeo.status.creatingJob"));

    let created = false;
    try {
      if (!connection) throw new Error(t("openeo.errors.connectFirst"));
      const process = await buildProcess();
      const job = await withTimeout(
        connection.createJob(
          process,
          jobTitle.trim() || t("openeo.defaultJobTitle"),
        ),
        OPERATION_TIMEOUT_MS,
        t("openeo.errors.createJobTimeout"),
      );
      if (startImmediately) {
        await withTimeout(
          job.startJob(),
          OPERATION_TIMEOUT_MS,
          t("openeo.errors.startJobTimeout"),
        );
      }
      setStatusMessage(
        startImmediately
          ? t("openeo.status.createdStartedJob", { id: job.id })
          : t("openeo.status.createdJob", { id: job.id }),
      );
      created = true;
    } catch (error) {
      setErrorMessage(formatError(error, t));
      setStatusMessage(null);
    } finally {
      setBusyAction(null);
    }
    if (created) {
      // Refresh the job list as a best-effort follow-up so a refresh failure
      // cannot mask the successful job creation. No argument so refreshJobs
      // reads the current `connection` from its own closure.
      void refreshJobs();
    }
  };

  const handleDownloadResult = async () => {
    setBusyAction("download");
    setErrorMessage(null);
    setStatusMessage(t("openeo.status.runningSync"));

    try {
      if (!connection) throw new Error(t("openeo.errors.connectFirst"));
      const process = await buildProcess();
      await withTimeout(
        connection.downloadResult(
          process,
          // The openEO client offers the result as a browser download using
          // this name; folders are not supported, so strip path separators.
          (downloadFilename.trim() || "openeo-result.tif").replace(
            /[\\/]/g,
            "_",
          ),
        ),
        SYNC_RESULT_TIMEOUT_MS,
        t("openeo.errors.syncTimeout"),
      );
      setStatusMessage(t("openeo.status.syncCompleted"));
    } catch (error) {
      setErrorMessage(formatError(error, t));
      setStatusMessage(null);
    } finally {
      setBusyAction(null);
    }
  };

  const refreshJobs = async (activeConnection = connection) => {
    if (!activeConnection) return;
    setBusyAction("jobs");
    setErrorMessage(null);
    try {
      setJobs(
        await withTimeout(
          activeConnection.listJobs(),
          OPERATION_TIMEOUT_MS,
          t("openeo.errors.loadJobsTimeout"),
        ),
      );
    } catch (error) {
      setErrorMessage(formatError(error, t));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(820px,92vh)] max-w-6xl grid-rows-[auto_minmax(0,1fr)] gap-0 p-0">
        <DialogHeader className="border-b px-6 py-4 pr-12">
          <DialogTitle className="flex items-center gap-2">
            <Server className="h-4 w-4" />
            {t("openeo.title")}
          </DialogTitle>
          <DialogDescription>{t("openeo.description")}</DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 grid-cols-1 md:grid-cols-[320px_minmax(0,1fr)]">
          <div className="min-h-0 border-b md:border-b-0 md:border-r">
            <ScrollArea className="h-full">
              <div className="space-y-5 p-4">
                <form className="space-y-3" onSubmit={handleConnect}>
                  <div className="space-y-2">
                    <Label htmlFor="openeo-backend">
                      {t("openeo.backendUrl")}
                    </Label>
                    <Input
                      id="openeo-backend"
                      value={backendUrl}
                      // Lock the URL while a connect is in flight so an edit
                      // cannot reset state out from under the pending request.
                      disabled={busyAction === "connect"}
                      onChange={(event) => {
                        setBackendUrl(event.target.value);
                        resetConnectionState();
                      }}
                    />
                  </div>

                  <label className="flex items-center gap-2 text-sm">
                    <input
                      checked={authEnabled}
                      className="h-4 w-4"
                      type="checkbox"
                      onChange={(event) => setAuthEnabled(event.target.checked)}
                    />
                    <Label className="cursor-pointer font-normal">
                      {t("openeo.basicAuth")}
                    </Label>
                  </label>

                  {authEnabled ? (
                    <div className="grid grid-cols-1 gap-3">
                      <div className="space-y-2">
                        <Label htmlFor="openeo-username">
                          {t("openeo.username")}
                        </Label>
                        <Input
                          id="openeo-username"
                          value={username}
                          onChange={(event) => setUsername(event.target.value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="openeo-password">
                          {t("openeo.password")}
                        </Label>
                        <Input
                          id="openeo-password"
                          type="password"
                          value={password}
                          onChange={(event) => setPassword(event.target.value)}
                        />
                      </div>
                    </div>
                  ) : null}

                  <Button className="w-full" disabled={isBusy} type="submit">
                    {busyAction === "connect" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Server className="h-4 w-4" />
                    )}
                    {t("openeo.connect")}
                  </Button>
                </form>

                {capabilities ? (
                  <div className="space-y-2 rounded-md border p-3 text-sm">
                    <div className="flex items-center gap-2 font-medium">
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      {t("openeo.apiLabel", {
                        version: capabilities.apiVersion(),
                      })}
                    </div>
                    <p className="text-muted-foreground">
                      {capabilities.description() ||
                        t("openeo.noDescription")}
                    </p>
                    {capabilities.listPlans().length ? (
                      <p className="text-xs text-muted-foreground">
                        {t("openeo.plans", {
                          plans: capabilities
                            .listPlans()
                            .map((plan) => plan.name)
                            .filter(Boolean)
                            .join(", "),
                        })}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {statusMessage ? (
                  <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm">
                    {statusMessage}
                  </div>
                ) : null}
                {errorMessage ? (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {errorMessage}
                  </div>
                ) : null}
              </div>
            </ScrollArea>
          </div>

          <ScrollArea className="min-h-0">
            <div className="space-y-5 p-5">
              <section className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-md border">
                  <div className="border-b p-3">
                    <Label htmlFor="openeo-collection-search">
                      {t("openeo.collections")}
                    </Label>
                    <Input
                      id="openeo-collection-search"
                      className="mt-2"
                      placeholder={t("openeo.searchCollections")}
                      value={collectionQuery}
                      onChange={(event) =>
                        setCollectionQuery(event.target.value)
                      }
                    />
                  </div>
                  <div className="max-h-64 overflow-auto">
                    {visibleCollections.length ? (
                      visibleCollections.map((collection, index) => (
                        <button
                          key={collection.id ?? `collection-${index}`}
                          className="block w-full border-b px-3 py-2 text-left text-sm hover:bg-accent"
                          type="button"
                          onClick={() =>
                            collection.id &&
                            setSelectedCollection(collection.id)
                          }
                        >
                          <span className="block truncate font-medium">
                            {collection.id}
                          </span>
                          <span className="line-clamp-2 text-xs text-muted-foreground">
                            {collection.summary ||
                              collection.description ||
                              collection.title}
                          </span>
                        </button>
                      ))
                    ) : (
                      <p className="p-3 text-sm text-muted-foreground">
                        {connection
                          ? t("openeo.noCollectionsMatch")
                          : t("openeo.connectToLoadCollections")}
                      </p>
                    )}
                    {filteredCollections.length > MAX_LIST_ITEMS ? (
                      <p className="p-3 text-xs text-muted-foreground">
                        {t("openeo.showingCollections", {
                          shown: MAX_LIST_ITEMS,
                          total: filteredCollections.length,
                        })}
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="rounded-md border">
                  <div className="border-b p-3">
                    <Label htmlFor="openeo-process-search">
                      {t("openeo.processes")}
                    </Label>
                    <Input
                      id="openeo-process-search"
                      className="mt-2"
                      placeholder={t("openeo.searchProcesses")}
                      value={processQuery}
                      onChange={(event) => setProcessQuery(event.target.value)}
                    />
                  </div>
                  <div className="max-h-64 overflow-auto">
                    {visibleProcesses.length ? (
                      visibleProcesses.map((process, index) => (
                        <div
                          key={process.id ?? `process-${index}`}
                          className="border-b px-3 py-2"
                        >
                          <span className="block truncate text-sm font-medium">
                            {process.id}
                          </span>
                          <span className="line-clamp-2 text-xs text-muted-foreground">
                            {process.summary || process.description}
                          </span>
                        </div>
                      ))
                    ) : (
                      <p className="p-3 text-sm text-muted-foreground">
                        {connection
                          ? t("openeo.noProcessesMatch")
                          : t("openeo.connectToLoadProcesses")}
                      </p>
                    )}
                    {filteredProcesses.length > MAX_LIST_ITEMS ? (
                      <p className="p-3 text-xs text-muted-foreground">
                        {t("openeo.showingProcesses", {
                          shown: MAX_LIST_ITEMS,
                          total: filteredProcesses.length,
                        })}
                      </p>
                    ) : null}
                  </div>
                </div>
              </section>

              <section className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold">
                    {t("openeo.processBuilder")}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {t("openeo.processBuilderHint")}
                  </p>
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="openeo-selected-collection">
                      {t("openeo.collectionId")}
                    </Label>
                    <Input
                      id="openeo-selected-collection"
                      value={selectedCollection}
                      onChange={(event) =>
                        setSelectedCollection(event.target.value)
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="openeo-bands">{t("openeo.bands")}</Label>
                    <Input
                      id="openeo-bands"
                      placeholder="VV,VH"
                      value={bands}
                      onChange={(event) => setBands(event.target.value)}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <div className="space-y-2">
                    <Label htmlFor="openeo-west">{t("openeo.west")}</Label>
                    <Input
                      id="openeo-west"
                      value={west}
                      onChange={(event) => setWest(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="openeo-south">{t("openeo.south")}</Label>
                    <Input
                      id="openeo-south"
                      value={south}
                      onChange={(event) => setSouth(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="openeo-east">{t("openeo.east")}</Label>
                    <Input
                      id="openeo-east"
                      value={east}
                      onChange={(event) => setEast(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="openeo-north">{t("openeo.north")}</Label>
                    <Input
                      id="openeo-north"
                      value={north}
                      onChange={(event) => setNorth(event.target.value)}
                    />
                  </div>
                </div>

                <div className="grid gap-4 lg:grid-cols-4">
                  <div className="space-y-2">
                    <Label htmlFor="openeo-start-date">
                      {t("openeo.startDate")}
                    </Label>
                    <Input
                      id="openeo-start-date"
                      type="date"
                      value={startDate}
                      onChange={(event) => setStartDate(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="openeo-end-date">
                      {t("openeo.endDate")}
                    </Label>
                    <Input
                      id="openeo-end-date"
                      type="date"
                      value={endDate}
                      onChange={(event) => setEndDate(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="openeo-reducer">
                      {t("openeo.reducer")}
                    </Label>
                    <Select
                      id="openeo-reducer"
                      value={reducer}
                      onChange={(event) =>
                        setReducer(event.target.value as Reducer)
                      }
                    >
                      <option value="none">{t("openeo.reducerNone")}</option>
                      <option value="mean">{t("openeo.reducerMean")}</option>
                      <option value="median">
                        {t("openeo.reducerMedian")}
                      </option>
                      <option value="min">{t("openeo.reducerMin")}</option>
                      <option value="max">{t("openeo.reducerMax")}</option>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="openeo-dimension">
                      {t("openeo.dimension")}
                    </Label>
                    <Input
                      id="openeo-dimension"
                      value={dimension}
                      onChange={(event) => setDimension(event.target.value)}
                    />
                  </div>
                </div>

                <div className="grid gap-4 lg:grid-cols-3">
                  <div className="space-y-2">
                    <Label htmlFor="openeo-output-format">
                      {t("openeo.outputFormat")}
                    </Label>
                    <Input
                      id="openeo-output-format"
                      value={outputFormat}
                      onChange={(event) => setOutputFormat(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2 lg:col-span-2">
                    <Label htmlFor="openeo-job-title">
                      {t("openeo.jobTitle")}
                    </Label>
                    <Input
                      id="openeo-job-title"
                      value={jobTitle}
                      onChange={(event) => setJobTitle(event.target.value)}
                    />
                  </div>
                </div>

                <label className="flex items-center gap-2 text-sm">
                  <input
                    checked={startImmediately}
                    className="h-4 w-4"
                    type="checkbox"
                    onChange={(event) =>
                      setStartImmediately(event.target.checked)
                    }
                  />
                  <Label className="cursor-pointer font-normal">
                    {t("openeo.startImmediately")}
                  </Label>
                </label>

                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={!connection || isBusy}
                    onClick={() => void handleCreateJob()}
                    type="button"
                  >
                    {busyAction === "job" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                    {t("openeo.createBatchJob")}
                  </Button>
                  <div className="flex min-w-64 flex-1 gap-2">
                    <Input
                      aria-label={t("openeo.downloadFilename")}
                      title={t("openeo.downloadFilenameHint")}
                      value={downloadFilename}
                      onChange={(event) =>
                        setDownloadFilename(event.target.value)
                      }
                    />
                    <Button
                      disabled={!connection || isBusy}
                      onClick={() => void handleDownloadResult()}
                      type="button"
                      variant="outline"
                    >
                      {busyAction === "download" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4" />
                      )}
                      {t("openeo.runSync")}
                    </Button>
                  </div>
                </div>
              </section>

              <section className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold">{t("openeo.jobs")}</h3>
                  <Button
                    disabled={!connection || isBusy}
                    onClick={() => void refreshJobs()}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {busyAction === "jobs" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    {t("openeo.refresh")}
                  </Button>
                </div>
                <div className="rounded-md border">
                  {jobs.length ? (
                    jobs.slice(0, MAX_JOB_ITEMS).map((job) => (
                      <div
                        key={job.id}
                        className="grid gap-1 border-b px-3 py-2 text-sm md:grid-cols-[minmax(0,1fr)_8rem_10rem]"
                      >
                        <span className="min-w-0 truncate">
                          {job.title || job.id}
                        </span>
                        <span className="text-muted-foreground">
                          {job.status || t("openeo.statusUnknown")}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {job.created || "—"}
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="p-3 text-sm text-muted-foreground">
                      {t("openeo.noJobsLoaded")}
                    </p>
                  )}
                  {jobs.length > MAX_JOB_ITEMS ? (
                    <p className="p-3 text-xs text-muted-foreground">
                      {t("openeo.showingJobs", {
                        shown: MAX_JOB_ITEMS,
                        total: jobs.length,
                      })}
                    </p>
                  ) : null}
                </div>
              </section>
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}
