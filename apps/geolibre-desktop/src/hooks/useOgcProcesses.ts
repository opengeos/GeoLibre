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
  ogcInputText,
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
  const [jobUrl, setJobUrl] = useState("");
  const [outputs, setOutputs] = useState<OgcProcessOutput[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
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
      setJobUrl("");
      setOutputs([]);
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
      if (current()) setError(failure instanceof Error ? failure.message : String(failure));
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
  const updateJob = (context: RequestContext, next: OgcProcessJob) =>
    context.commit(() => {
      setJob(next);
      setJobUrl(next.url);
    });
  const monitor = async (initial: OgcProcessJob | string, context: RequestContext) => {
    context.commit(() => setPhase("monitoring"));
    const result = await monitorOgcProcessJob(initial, context.signal, (next) =>
      updateJob(context, next),
    );
    context.commit(() => setOutputs(result));
  };
  const execute = () =>
    run("executing", async (context) => {
      if (!process) return;
      const inputs: unknown = jsonMode
        ? JSON.parse(inputsJson)
        : parseOgcProcessInputs(process, values);
      if (!inputs || typeof inputs !== "object" || Array.isArray(inputs))
        throw new Error("Process inputs must be a JSON object.");
      context.commit(() => {
        setOutputs([]);
        setJob(null);
        setJobUrl("");
      });
      const result = await executeOgcProcess(
        process,
        inputs as Record<string, unknown>,
        context.signal,
        asynchronous,
      );
      context.signal.throwIfAborted();
      if (result.kind === "job") {
        updateJob(context, result.job);
        await monitor(result.job, context);
      } else {
        context.commit(() => {
          setOutputs(result.outputs);
          setJobUrl(result.jobUrl ?? "");
        });
        if (result.jobUrl) {
          try {
            updateJob(context, await readOgcProcessJob(result.jobUrl, context.signal));
          } catch (failure) {
            if (context.signal.aborted) throw failure;
          }
        }
      }
    });
  const resume = () => run("monitoring", (context) => monitor(jobUrl.trim(), context));
  const dismiss = () =>
    run("dismissing", async (context) => {
      await dismissOgcProcessJob(jobUrl.trim(), context.signal);
      context.commit(() =>
        setJob((previous) => (previous ? { ...previous, status: "dismissed" } : null)),
      );
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
        setError(failure instanceof Error ? failure.message : String(failure));
        return;
      }
    }
    if (!next && process) {
      try {
        const parsed: unknown = JSON.parse(inputsJson);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("Process inputs must be a JSON object.");
        if (Object.keys(parsed).some((key) => !Object.hasOwn(process.inputs, key)))
          throw new Error("Keep JSON mode for inputs that are not in the advertised schema.");
        setValues(
          Object.fromEntries(
            Object.entries(parsed).map(([key, value]) => [
              key,
              ogcInputText(value, ogcInputKind(process.inputs[key])),
            ]),
          ),
        );
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
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
    jobUrl,
    setJobUrl,
    outputs,
    phase,
    busy: phase !== "idle",
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
