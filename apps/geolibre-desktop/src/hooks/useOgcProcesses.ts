import { OgcProcessError, ogcProcessErrorText } from "../lib/ogc-process-errors";
import { useAppStore } from "@geolibre/core";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  describeOgcProcess,
  discoverOgcProcesses,
  dismissOgcProcessJob,
  executeOgcProcess,
  readOgcProcessJob,
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
  const [jobsByProcess, setJobsByProcess] = useState(() => new Map<string, OgcProcessJob>());
  const [jobUrl, setJobUrl] = useState("");
  const [outputs, setOutputs] = useState<OgcProcessOutput[]>([]);
  const [outputSourceUrl, setOutputSourceUrl] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<unknown>(null);
  const active = useRef<AbortController | null>(null);
  const submitting = useRef<AbortSignal | null>(null);

  const parseJsonInputs = (value: string): unknown => {
    try {
      return JSON.parse(value);
    } catch {
      throw new OgcProcessError("inputsJsonSyntax");
    }
  };

  const stop = useCallback(() => {
    if (submitting.current && !submitting.current.aborted)
      setError(new OgcProcessError("executionUncertain", { detail: "" }));
    submitting.current = null;
    active.current?.abort();
    active.current = null;
    setPhase("idle");
  }, []);

  useEffect(() => {
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.projectLoadCount === previous.projectLoadCount) return;
      stop();
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
      active.current?.abort();
      active.current = null;
    };
  }, [stop]);
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
      const previousJob = jobsByProcess.get(full.url);
      setJob(previousJob ?? null);
      setJobUrl(previousJob?.url ?? "");
      setValues(defaults);
      setJsonMode(false);
      setInputsJson(JSON.stringify(parseOgcProcessInputs(full, defaults, false), null, 2));
      setAsynchronous(
        !full.jobControlOptions.includes("sync-execute") &&
          full.jobControlOptions.includes("async-execute"),
      );
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
  const updateJob = (context: RequestContext, next: OgcProcessJob, processUrl?: string) =>
    context.commit(() => {
      setJob(next);
      setJobUrl(next.url);
      if (processUrl) setJobsByProcess((previous) => new Map(previous).set(processUrl, next));
    });
  const monitor = async (
    initial: OgcProcessJob | string,
    context: RequestContext,
    processUrl?: string,
  ) => {
    context.commit(() => {
      setPhase("monitoring");
      setOutputs([]);
      setOutputSourceUrl("");
    });
    let sourceUrl = typeof initial === "string" ? initial : initial.url;
    const result = await monitorOgcProcessJob(initial, context.signal, (next) => {
      sourceUrl = next.url;
      updateJob(context, next, processUrl);
    });
    context.commit(() => {
      setOutputs(result);
      setOutputSourceUrl(sourceUrl);
    });
  };
  const execute = () =>
    run("executing", async (context) => {
      if (!process) return;
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
      submitting.current = context.signal;
      const result = await (async () => {
        try {
          return await executeOgcProcess(
            process,
            inputs as Record<string, unknown>,
            context.signal,
            asynchronous,
          );
        } catch (failure) {
          if (context.signal.aborted || failure instanceof OgcProcessError) throw failure;
          throw new OgcProcessError("executionUncertain", { detail: ogcProcessErrorText(failure) });
        } finally {
          if (submitting.current === context.signal) submitting.current = null;
        }
      })();
      context.signal.throwIfAborted();
      if (result.kind === "job") {
        updateJob(context, result.job, process.url);
        await monitor(result.job, context, process.url);
      } else {
        context.commit(() => {
          setOutputs(result.outputs);
          setOutputSourceUrl(result.jobUrl ?? process.url);
          setJobUrl(result.jobUrl ?? "");
        });
        if (result.jobUrl) {
          try {
            updateJob(
              context,
              {
                ...(await readOgcProcessJob(result.jobUrl, context.signal)),
                outputIds: Object.keys(process.outputs),
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
      const tracked = [...jobsByProcess].find(([, value]) => value.url === jobUrl.trim());
      return monitor(
        tracked?.[1] ?? (job?.url === jobUrl.trim() ? job : jobUrl.trim()),
        context,
        tracked?.[0],
      );
    });
  const dismiss = () =>
    run("dismissing", async (context) => {
      await dismissOgcProcessJob(jobUrl.trim(), context.signal);
      context.commit(() => {
        setJob((previous) =>
          previous?.url === jobUrl.trim() ? { ...previous, status: "dismissed" } : null,
        );
        setJobsByProcess(
          (previous) =>
            new Map(
              [...previous].map(([key, value]) => [
                key,
                value.url === jobUrl.trim() ? { ...value, status: "dismissed" as const } : value,
              ]),
            ),
        );
      });
    });
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
      jobsByProcess.get(process?.url ?? "")?.status ?? "",
    ),
    jobUrl,
    setJobUrl,
    outputs,
    outputSourceUrl,
    phase,
    busy: phase !== "idle",
    error: error === null ? null : ogcProcessErrorText(error),
    retrieve,
    select,
    execute,
    resume,
    dismiss,
    stop,
    run,
  };
}
