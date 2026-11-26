import { OgcProcessError, ogcProcessErrorText } from "../lib/ogc-process-errors";
import { useAppStore } from "@geolibre/core";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  describeOgcProcess,
  discoverOgcProcesses,
  dismissOgcProcessJob,
  executeOgcProcess,
  readOgcProcessJob,
  sameOgcProcessJob,
  ogcProcessIdentity,
  type OgcProcess,
  type OgcProcessJob,
  type OgcProcessOutput,
} from "../lib/ogc-api-processes";
import { monitorOgcProcessJob } from "../lib/ogc-process-job";
import {
  ogcInputKind,
  ogcInputFieldText,
  ogcProcessInputDefaults,
  parseOgcProcessInputs,
} from "../lib/ogc-process-inputs";

type Phase =
  | "idle"
  | "discovering"
  | "describing"
  | "executing"
  | "awaiting"
  | "monitoring"
  | "dismissing"
  | "output";
type RequestContext = { signal: AbortSignal; commit: (update: () => void) => void };

/** Own a dialog's protocol work without letting late results cross projects or requests. */
export function useOgcProcesses(open: boolean) {
  const [endpoint, setEndpoint] = useState("https://demo.pygeoapi.io/master/");
  const [processes, setProcesses] = useState<OgcProcess[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [process, setProcess] = useState<OgcProcess | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [jsonMode, setJsonMode] = useState(false);
  const [inputsJson, setInputsJson] = useState("{}");
  const [asynchronous, setAsynchronous] = useState(false);
  const [job, setJob] = useState<OgcProcessJob | null>(null);
  const retainedJobs = useRef(new Map<string, OgcProcessJob>());
  const [jobsByProcess, publishJobsByProcess] = useState(retainedJobs.current);
  const setJobsByProcess = useCallback(
    (
      update:
        | Map<string, OgcProcessJob>
        | ((previous: Map<string, OgcProcessJob>) => Map<string, OgcProcessJob>),
    ) => {
      const next = typeof update === "function" ? update(retainedJobs.current) : update;
      retainedJobs.current = next;
      publishJobsByProcess(next);
    },
    [],
  );
  const [jobUrl, setJobUrl] = useState("");
  const [outputs, setOutputs] = useState<OgcProcessOutput[]>([]);
  const [outputSourceUrl, setOutputSourceUrl] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<unknown>(null);
  const active = useRef<AbortController | null>(null);
  const observedJob = useRef<{ initialUrl: string; url: string; signal: AbortSignal } | null>(null);
  const pendingSubmission = useRef<{ controller: AbortController; processUrl: string } | null>(
    null,
  );
  const [awaitingSubmission, setAwaitingSubmission] = useState(false);
  const mounted = useRef(true);
  const selectedProcess = useRef(process);
  selectedProcess.current = process;

  const parseJsonInputs = (value: string): unknown => {
    try {
      return JSON.parse(value);
    } catch {
      throw new OgcProcessError("inputsJsonSyntax");
    }
  };

  const stop = useCallback(() => {
    if (pendingSubmission.current && !pendingSubmission.current.controller.signal.aborted)
      setError(new OgcProcessError("submissionPending"));
    active.current?.abort();
    active.current = null;
    observedJob.current = null;
    setPhase(pendingSubmission.current ? "awaiting" : "idle");
  }, []);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.projectLoadCount === previous.projectLoadCount) return;
      stop();
      // Keep a dispatched submission bounded by its transport deadline. Aborting
      // browser fetch here would release its lock before the acknowledgement.
      // The captured project still prevents publishing any of its private results.
      setAwaitingSubmission(Boolean(pendingSubmission.current));
      setPhase(pendingSubmission.current ? "awaiting" : "idle");
      setProcesses([]);
      setProcess(null);
      setSelectedId("");
      setValues({});
      setJob(null);
      setJobsByProcess(new Map());
      setJobUrl("");
      setOutputs([]);
      setOutputSourceUrl("");
      setError(null);
      setInputsJson("{}");
    });
    return () => {
      unsubscribe();
      mounted.current = false;
      pendingSubmission.current?.controller.abort();
      pendingSubmission.current = null;
      active.current?.abort();
      active.current = null;
    };
  }, [stop, setJobsByProcess]);
  useEffect(() => {
    if (!open) stop();
  }, [open, stop]);

  const run = useCallback(async (next: Phase, work: (context: RequestContext) => Promise<void>) => {
    active.current?.abort();
    const request = new AbortController();
    const project = useAppStore.getState().projectLoadCount;
    active.current = request;
    setPhase(next);
    setError(null);
    const current = () =>
      active.current === request &&
      !request.signal.aborted &&
      useAppStore.getState().projectLoadCount === project;
    try {
      await work({
        signal: request.signal,
        commit: (update) => {
          if (current()) update();
        },
      });
    } catch (failure) {
      if (current()) setError(failure);
    } finally {
      if (active.current === request) {
        active.current = null;
        setPhase("idle");
      }
    }
  }, []);

  const loadDescription = async (summary: OgcProcess, context: RequestContext) => {
    context.commit(() => {
      setSelectedId(summary.id);
      setProcess(null);
      setOutputs([]);
      setPhase("describing");
    });
    const full = await describeOgcProcess(summary, context.signal);
    const defaults = ogcProcessInputDefaults(full);
    context.commit(() => {
      setProcess(full);
      const previousJob = retainedJobs.current.get(ogcProcessIdentity(full.url));
      setJob(previousJob ?? null);
      setJobUrl(previousJob?.url ?? "");
      setValues(defaults);
      setJsonMode(false);
      setAsynchronous(
        !full.jobControlOptions.includes("sync-execute") &&
          full.jobControlOptions.includes("async-execute"),
      );
      setInputsJson(JSON.stringify(parseOgcProcessInputs(full, defaults, false), null, 2));
    });
  };
  const retrieve = () =>
    run("discovering", async (context) => {
      context.commit(() => {
        setProcesses([]);
        setProcess(null);
        setOutputs([]);
      });
      const items = await discoverOgcProcesses(endpoint, context.signal);
      context.commit(() => setProcesses(items));
      context.signal.throwIfAborted();
      await loadDescription(items[0], context);
    });
  const select = (id: string) =>
    run("describing", async (context) => {
      const summary = processes.find((item) => item.id === id);
      if (summary) await loadDescription(summary, context);
    });
  const updateJob = (
    context: RequestContext,
    next: OgcProcessJob,
    processUrl?: string,
    observedUrl = next.url,
  ) =>
    context.commit(() => {
      setJob((previous) =>
        previous?.status === "dismissed" &&
        (sameOgcProcessJob(previous.url, next.url) || sameOgcProcessJob(previous.url, observedUrl))
          ? previous
          : next,
      );
      setJobUrl(next.url);
      if (processUrl)
        setJobsByProcess((previous) => {
          const key = ogcProcessIdentity(processUrl);
          const tracked = previous.get(key);
          if (
            tracked?.status === "dismissed" &&
            (sameOgcProcessJob(tracked.url, next.url) ||
              sameOgcProcessJob(tracked.url, observedUrl))
          )
            return previous;
          if (
            tracked &&
            ["accepted", "running"].includes(tracked.status) &&
            !sameOgcProcessJob(tracked.url, next.url) &&
            !sameOgcProcessJob(tracked.url, observedUrl)
          )
            return previous;
          return new Map(previous).set(key, next);
        });
    });
  const monitor = async (
    initial: OgcProcessJob | string,
    context: RequestContext,
    processUrl?: string,
  ) => {
    context.commit(() => {
      setPhase("monitoring");
      const target = typeof initial === "string" ? initial : initial.url;
      if (!sameOgcProcessJob(outputSourceUrl, target)) {
        setOutputs([]);
        setOutputSourceUrl("");
      }
    });
    let sourceUrl = typeof initial === "string" ? initial : initial.url;
    let owningProcessUrl = processUrl;
    const observation = { initialUrl: sourceUrl, url: sourceUrl, signal: context.signal };
    observedJob.current = observation;
    try {
      const result = await monitorOgcProcessJob(initial, context.signal, (next) => {
        observation.url = next.url;
        const selectedUrl = selectedProcess.current?.url;
        if (
          !owningProcessUrl &&
          selectedUrl &&
          next.processUrl &&
          sameOgcProcessJob(selectedUrl, next.processUrl)
        )
          owningProcessUrl = selectedUrl;
        const key = owningProcessUrl ?? next.processUrl;
        updateJob(context, next, key, sourceUrl);
        sourceUrl = next.url;
      });
      context.commit(() => {
        setOutputs(result);
        setOutputSourceUrl(sourceUrl);
      });
    } finally {
      if (observedJob.current === observation) observedJob.current = null;
    }
  };
  const execute = () =>
    run("executing", async (context) => {
      if (!process) return;
      if (pendingSubmission.current) throw new OgcProcessError("submissionPending");
      const inputs: unknown = jsonMode
        ? parseJsonInputs(inputsJson)
        : parseOgcProcessInputs(process, values);
      if (!inputs || typeof inputs !== "object" || Array.isArray(inputs))
        throw new OgcProcessError("inputObject");
      context.commit(() => {
        setOutputs([]);
        setJob(null);
        setJobUrl("");
      });
      const project = useAppStore.getState().projectLoadCount;
      const submission = { controller: new AbortController(), processUrl: process.url };
      const ownsProject = () =>
        mounted.current && useAppStore.getState().projectLoadCount === project;
      const canPublishDetached = () =>
        ownsProject() && selectedProcess.current?.url === process.url && !active.current;
      pendingSubmission.current = submission;
      setAwaitingSubmission(true);
      const result = await (async () => {
        try {
          return await executeOgcProcess(
            process,
            inputs as Record<string, unknown>,
            submission.controller.signal,
            asynchronous,
          );
        } catch (failure) {
          const error =
            failure instanceof OgcProcessError && failure.code !== "requestTimeout"
              ? failure
              : new OgcProcessError("executionUncertain", { detail: ogcProcessErrorText(failure) });
          if (context.signal.aborted) {
            if (canPublishDetached()) setError(error);
            return undefined;
          }
          throw error;
        } finally {
          if (pendingSubmission.current === submission) {
            pendingSubmission.current = null;
            if (mounted.current) {
              setAwaitingSubmission(false);
              if (context.signal.aborted && !active.current) setPhase("idle");
            }
          }
        }
      })();
      if (!result || !ownsProject()) return;
      const submissionJob = result.job;
      if (context.signal.aborted) {
        if (submissionJob)
          setJobsByProcess((previous) =>
            new Map(previous).set(ogcProcessIdentity(process.url), submissionJob),
          );
        if (canPublishDetached()) {
          setError(null);
          if (result.kind === "job") {
            setJob(result.job);
            setJobUrl(result.job.url);
          } else {
            setOutputs(result.outputs);
            setOutputSourceUrl(result.job?.url ?? process.url);
            setJob(result.job ?? null);
            setJobUrl(result.job?.url ?? "");
          }
        }
        return;
      }
      context.signal.throwIfAborted();
      if (result.kind === "job") {
        updateJob(context, result.job, process.url);
        await monitor(result.job, context, process.url);
      } else {
        context.commit(() => {
          setOutputs(result.outputs);
          setOutputSourceUrl(result.job?.url ?? process.url);
          setJobUrl(result.job?.url ?? "");
        });
        if (result.job) {
          updateJob(context, result.job, process.url);
          try {
            updateJob(
              context,
              {
                ...(await readOgcProcessJob(result.job.url, context.signal)),
                outputIds: Object.keys(process.outputs),
                outputDefinitions: process.outputs,
                processUrl: process.url,
              },
              process.url,
            );
          } catch (failure) {
            if (context.signal.aborted) throw failure;
          }
        }
      }
    });
  const resume = () =>
    run("monitoring", (context) => {
      const tracked = [...retainedJobs.current].find(([, value]) =>
        sameOgcProcessJob(value.url, jobUrl.trim()),
      );
      return monitor(
        tracked?.[1] ?? (job && sameOgcProcessJob(job.url, jobUrl.trim()) ? job : jobUrl.trim()),
        context,
        tracked?.[0],
      );
    });
  const dismiss = () => {
    const target = jobUrl.trim();
    const observation = observedJob.current;
    // run replaces the active request and aborts the monitor. Preserve its
    // known aliases before that transition, even if its finally clears the ref.
    const knownUrls = [target];
    if (
      observation &&
      active.current?.signal === observation.signal &&
      (sameOgcProcessJob(observation.initialUrl, target) ||
        sameOgcProcessJob(observation.url, target))
    )
      knownUrls.push(observation.initialUrl, observation.url);
    return run("dismissing", async (context) => {
      const project = useAppStore.getState().projectLoadCount;
      await dismissOgcProcessJob(target, context.signal);
      if (!mounted.current || useAppStore.getState().projectLoadCount !== project) return;
      // A caller may resume this job while DELETE is pending. Its current
      // observation can supply another canonical URL, but an unrelated monitor
      // must not be stopped or acquire the dismissal's state.
      const observationAtCompletion = observedJob.current;
      const matchingLiveObservation =
        observationAtCompletion &&
        active.current?.signal === observationAtCompletion.signal &&
        knownUrls.some(
          (url) =>
            sameOgcProcessJob(url, observationAtCompletion.initialUrl) ||
            sameOgcProcessJob(url, observationAtCompletion.url),
        )
          ? observationAtCompletion
          : null;
      const relatedUrls = matchingLiveObservation
        ? [...knownUrls, matchingLiveObservation.initialUrl, matchingLiveObservation.url]
        : knownUrls;
      const matchesTarget = (url: string) =>
        relatedUrls.some((alias) => sameOgcProcessJob(url, alias));
      // A completed remote mutation survives stopped observation. Only update
      // its retained identity; another displayed job may now own the dialog.
      setJob((previous) =>
        previous && matchesTarget(previous.url) ? { ...previous, status: "dismissed" } : previous,
      );
      setJobsByProcess(
        (previous) =>
          new Map(
            [...previous].map(([key, value]) => [
              key,
              matchesTarget(value.url) ? { ...value, status: "dismissed" as const } : value,
            ]),
          ),
      );
      if (matchingLiveObservation) stop();
    });
  };
  const changeEndpoint = (value: string) => {
    stop();
    setEndpoint(value);
    setProcesses([]);
    setSelectedId("");
    setProcess(null);
    setError(null);
  };
  const toggleJson = (next: boolean) => {
    if (next && process) {
      try {
        setInputsJson(JSON.stringify(parseOgcProcessInputs(process, values, false), null, 2));
      } catch (failure) {
        setError(failure);
        return;
      }
    }
    if (!next && process) {
      try {
        const parsed: unknown = parseJsonInputs(inputsJson);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new OgcProcessError("inputObject");
        if (Object.keys(parsed).some((key) => !Object.hasOwn(process.inputs, key)))
          throw new OgcProcessError("unknownInputs");
        setValues(
          Object.fromEntries(
            Object.entries(parsed).map(([key, value]) => [
              key,
              ogcInputFieldText(value, ogcInputKind(process.inputs[key])),
            ]),
          ),
        );
      } catch (failure) {
        setError(failure);
        return;
      }
    }
    setJsonMode(next);
  };
  return {
    endpoint,
    changeEndpoint,
    processes,
    selectedId,
    process,
    values,
    setValues,
    jsonMode,
    toggleJson,
    inputsJson,
    setInputsJson,
    asynchronous,
    setAsynchronous,
    job,
    runningForProcess: ["accepted", "running"].includes(
      (process ? jobsByProcess.get(ogcProcessIdentity(process.url))?.status : undefined) ?? "",
    ),
    jobUrl,
    setJobUrl,
    outputs,
    outputSourceUrl,
    phase,
    busy: phase !== "idle" || awaitingSubmission,
    error,
    retrieve,
    select,
    execute,
    resume,
    dismiss,
    stop,
    run,
  };
}
