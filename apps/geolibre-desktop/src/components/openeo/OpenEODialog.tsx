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
import openEOClient from "@openeo/js-client";
import {
  CheckCircle2,
  Download,
  Loader2,
  Play,
  RefreshCw,
  Server,
} from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";

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

const DEFAULT_BACKEND_URL = "https://earthengine.openeo.org";
const DEFAULT_COLLECTION = "COPERNICUS/S1_GRD";
const DEFAULT_BANDS = "VV,VH";
const DEFAULT_OUTPUT_FORMAT = "GTiff";

function parseBands(value: string): string[] | undefined {
  const bands = value
    .split(",")
    .map((band) => band.trim())
    .filter(Boolean);
  return bands.length ? bands : undefined;
}

function parseNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a number.`);
  }
  return parsed;
}

function buildBoundingBox(values: {
  west: string;
  south: string;
  east: string;
  north: string;
}): OpenEOBoundingBox {
  const bbox = {
    west: parseNumber(values.west, "West"),
    south: parseNumber(values.south, "South"),
    east: parseNumber(values.east, "East"),
    north: parseNumber(values.north, "North"),
  };

  if (bbox.west >= bbox.east) {
    throw new Error("West must be less than east.");
  }
  if (bbox.south >= bbox.north) {
    throw new Error("South must be less than north.");
  }
  return bbox;
}

function filterByQuery<T extends { id?: string; title?: string; summary?: string }>(
  values: T[],
  query: string,
): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return values.slice(0, 24);

  return values
    .filter((value) =>
      [value.id, value.title, value.summary]
        .filter(Boolean)
        .some((text) => text!.toLowerCase().includes(normalizedQuery)),
    )
    .slice(0, 24);
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "The openEO request failed.";
}

function createReducer(builder: OpenEOBuilder, reducer: Reducer) {
  return function reducerCallback(this: OpenEOBuilder, data: unknown): unknown {
    const context = this ?? builder;
    if (reducer === "mean") return context.mean(data);
    if (reducer === "median") return context.median(data);
    if (reducer === "min") return context.min(data);
    if (reducer === "max") return context.max(data);
    return data;
  };
}

export function OpenEODialog({ open, onOpenChange }: OpenEODialogProps) {
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
  const [jobTitle, setJobTitle] = useState("GeoLibre openEO job");
  const [startImmediately, setStartImmediately] = useState(true);
  const [downloadFilename, setDownloadFilename] =
    useState("openeo-result.tif");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const visibleCollections = useMemo(
    () => filterByQuery(collections, collectionQuery),
    [collections, collectionQuery],
  );
  const visibleProcesses = useMemo(
    () => filterByQuery(processes, processQuery),
    [processes, processQuery],
  );

  const isBusy = busyAction !== null;

  const resetConnectionState = () => {
    setConnection(null);
    setCapabilities(null);
    setCollections([]);
    setProcesses([]);
    setJobs([]);
  };

  const handleConnect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const url = backendUrl.trim();
    if (!url) {
      setErrorMessage("Enter an openEO backend URL.");
      return;
    }
    if (authEnabled && (!username.trim() || !password)) {
      setErrorMessage("Enter the basic authentication username and password.");
      return;
    }

    setBusyAction("connect");
    setErrorMessage(null);
    setStatusMessage("Connecting to openEO backend...");
    resetConnectionState();

    try {
      const nextConnection = (await openEOClient.OpenEO.connect(
        url,
      )) as unknown as OpenEOConnection;
      if (authEnabled) {
        await nextConnection.authenticateBasic(username.trim(), password);
      }
      const nextCapabilities = nextConnection.capabilities();
      setConnection(nextConnection);
      setCapabilities(nextCapabilities);
      setStatusMessage(
        `Connected to API ${nextCapabilities.apiVersion() || "unknown"}.`,
      );

      const [collectionResponse, processResponse] = await Promise.all([
        nextConnection.listCollections(),
        nextConnection.listProcesses(),
      ]);
      const nextCollections = collectionResponse.collections ?? [];
      const nextProcesses = processResponse.processes ?? [];
      setCollections(nextCollections);
      setProcesses(nextProcesses);
      if (!selectedCollection && nextCollections[0]?.id) {
        setSelectedCollection(nextCollections[0].id);
      }
      setStatusMessage(
        `Connected. Loaded ${nextCollections.length} collections and ${nextProcesses.length} processes.`,
      );
    } catch (error) {
      setErrorMessage(formatError(error));
      setStatusMessage(null);
    } finally {
      setBusyAction(null);
    }
  };

  const buildProcess = async (): Promise<unknown> => {
    if (!connection) throw new Error("Connect to an openEO backend first.");
    if (!selectedCollection.trim()) throw new Error("Enter a collection ID.");
    if (!startDate || !endDate) {
      throw new Error("Enter start and end dates.");
    }

    const bbox = buildBoundingBox({ west, south, east, north });
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
        createReducer(builder, reducer),
        dimension.trim() || "t",
      );
    }

    return builder.save_result(datacube, outputFormat.trim() || "GTiff");
  };

  const handleCreateJob = async () => {
    setBusyAction("job");
    setErrorMessage(null);
    setStatusMessage("Creating openEO batch job...");

    try {
      if (!connection) throw new Error("Connect to an openEO backend first.");
      const process = await buildProcess();
      const job = await connection.createJob(
        process,
        jobTitle.trim() || "GeoLibre openEO job",
      );
      if (startImmediately) {
        await job.startJob();
      }
      setStatusMessage(
        startImmediately
          ? `Created and started job ${job.id}.`
          : `Created job ${job.id}.`,
      );
      await refreshJobs(connection);
    } catch (error) {
      setErrorMessage(formatError(error));
      setStatusMessage(null);
    } finally {
      setBusyAction(null);
    }
  };

  const handleDownloadResult = async () => {
    setBusyAction("download");
    setErrorMessage(null);
    setStatusMessage("Running synchronous openEO process...");

    try {
      if (!connection) throw new Error("Connect to an openEO backend first.");
      const process = await buildProcess();
      await connection.downloadResult(
        process,
        downloadFilename.trim() || "openeo-result.tif",
      );
      setStatusMessage("Synchronous result request completed.");
    } catch (error) {
      setErrorMessage(formatError(error));
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
      setJobs(await activeConnection.listJobs());
    } catch (error) {
      setErrorMessage(formatError(error));
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
            openEO
          </DialogTitle>
          <DialogDescription>
            Connect to an openEO backend, inspect available resources, and
            submit a collection processing job.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 grid-cols-1 md:grid-cols-[320px_minmax(0,1fr)]">
          <div className="min-h-0 border-b md:border-b-0 md:border-r">
            <ScrollArea className="h-full">
              <div className="space-y-5 p-4">
                <form className="space-y-3" onSubmit={handleConnect}>
                  <div className="space-y-2">
                    <Label htmlFor="openeo-backend">Backend URL</Label>
                    <Input
                      id="openeo-backend"
                      value={backendUrl}
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
                    Basic authentication
                  </label>

                  {authEnabled ? (
                    <div className="grid grid-cols-1 gap-3">
                      <div className="space-y-2">
                        <Label htmlFor="openeo-username">Username</Label>
                        <Input
                          id="openeo-username"
                          value={username}
                          onChange={(event) => setUsername(event.target.value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="openeo-password">Password</Label>
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
                    Connect
                  </Button>
                </form>

                {capabilities ? (
                  <div className="space-y-2 rounded-md border p-3 text-sm">
                    <div className="flex items-center gap-2 font-medium">
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      API {capabilities.apiVersion()}
                    </div>
                    <p className="text-muted-foreground">
                      {capabilities.description() || "No description provided."}
                    </p>
                    {capabilities.listPlans().length ? (
                      <p className="text-xs text-muted-foreground">
                        Plans:{" "}
                        {capabilities
                          .listPlans()
                          .map((plan) => plan.name)
                          .filter(Boolean)
                          .join(", ")}
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
                      Collections
                    </Label>
                    <Input
                      id="openeo-collection-search"
                      className="mt-2"
                      placeholder="Search collection IDs"
                      value={collectionQuery}
                      onChange={(event) =>
                        setCollectionQuery(event.target.value)
                      }
                    />
                  </div>
                  <div className="max-h-64 overflow-auto">
                    {visibleCollections.length ? (
                      visibleCollections.map((collection) => (
                        <button
                          key={collection.id}
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
                        Connect to a backend to load collections.
                      </p>
                    )}
                  </div>
                </div>

                <div className="rounded-md border">
                  <div className="border-b p-3">
                    <Label htmlFor="openeo-process-search">Processes</Label>
                    <Input
                      id="openeo-process-search"
                      className="mt-2"
                      placeholder="Search process IDs"
                      value={processQuery}
                      onChange={(event) => setProcessQuery(event.target.value)}
                    />
                  </div>
                  <div className="max-h-64 overflow-auto">
                    {visibleProcesses.length ? (
                      visibleProcesses.map((process) => (
                        <div key={process.id} className="border-b px-3 py-2">
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
                        Connect to a backend to load processes.
                      </p>
                    )}
                  </div>
                </div>
              </section>

              <section className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold">Process Builder</h3>
                  <p className="text-xs text-muted-foreground">
                    Uses `load_collection`, optional `reduce_dimension`, and
                    `save_result` from the openEO JavaScript client.
                  </p>
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="openeo-selected-collection">
                      Collection ID
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
                    <Label htmlFor="openeo-bands">Bands</Label>
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
                    <Label htmlFor="openeo-west">West</Label>
                    <Input
                      id="openeo-west"
                      value={west}
                      onChange={(event) => setWest(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="openeo-south">South</Label>
                    <Input
                      id="openeo-south"
                      value={south}
                      onChange={(event) => setSouth(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="openeo-east">East</Label>
                    <Input
                      id="openeo-east"
                      value={east}
                      onChange={(event) => setEast(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="openeo-north">North</Label>
                    <Input
                      id="openeo-north"
                      value={north}
                      onChange={(event) => setNorth(event.target.value)}
                    />
                  </div>
                </div>

                <div className="grid gap-4 lg:grid-cols-4">
                  <div className="space-y-2">
                    <Label htmlFor="openeo-start-date">Start date</Label>
                    <Input
                      id="openeo-start-date"
                      type="date"
                      value={startDate}
                      onChange={(event) => setStartDate(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="openeo-end-date">End date</Label>
                    <Input
                      id="openeo-end-date"
                      type="date"
                      value={endDate}
                      onChange={(event) => setEndDate(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="openeo-reducer">Reducer</Label>
                    <Select
                      id="openeo-reducer"
                      value={reducer}
                      onChange={(event) =>
                        setReducer(event.target.value as Reducer)
                      }
                    >
                      <option value="none">None</option>
                      <option value="mean">Mean</option>
                      <option value="median">Median</option>
                      <option value="min">Minimum</option>
                      <option value="max">Maximum</option>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="openeo-dimension">Dimension</Label>
                    <Input
                      id="openeo-dimension"
                      value={dimension}
                      onChange={(event) => setDimension(event.target.value)}
                    />
                  </div>
                </div>

                <div className="grid gap-4 lg:grid-cols-3">
                  <div className="space-y-2">
                    <Label htmlFor="openeo-output-format">Output format</Label>
                    <Input
                      id="openeo-output-format"
                      value={outputFormat}
                      onChange={(event) => setOutputFormat(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2 lg:col-span-2">
                    <Label htmlFor="openeo-job-title">Batch job title</Label>
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
                  Start batch job immediately
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
                    Create Batch Job
                  </Button>
                  <div className="flex min-w-64 flex-1 gap-2">
                    <Input
                      aria-label="Download filename"
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
                      Run Sync
                    </Button>
                  </div>
                </div>
              </section>

              <section className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold">Jobs</h3>
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
                    Refresh
                  </Button>
                </div>
                <div className="rounded-md border">
                  {jobs.length ? (
                    jobs.slice(0, 20).map((job) => (
                      <div
                        key={job.id}
                        className="grid gap-1 border-b px-3 py-2 text-sm md:grid-cols-[minmax(0,1fr)_8rem_10rem]"
                      >
                        <span className="min-w-0 truncate">
                          {job.title || job.id}
                        </span>
                        <span className="text-muted-foreground">
                          {job.status || "unknown"}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {job.created || job.id}
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="p-3 text-sm text-muted-foreground">
                      No jobs loaded.
                    </p>
                  )}
                </div>
              </section>
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}
