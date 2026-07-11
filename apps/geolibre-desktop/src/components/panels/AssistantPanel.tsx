import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { Button, Select, Textarea, cn } from "@geolibre/ui";
import {
  AlertCircle,
  Eraser,
  Loader2,
  Send,
  Settings,
  ShieldAlert,
  Sparkles,
  Square,
  Wrench,
  X,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { AssistantSession } from "../../lib/assistant/agent";
import { renderAssistantMarkdown } from "../../lib/assistant/markdown";
import { openSettingsSection } from "../layout/SettingsDialog";
import {
  ASSISTANT_PROVIDER_IDS,
  availableProviders,
  defaultModelFor,
  hasProviderKey,
  PROVIDER_LABELS,
  PROVIDER_MODELS,
  type AssistantProviderId,
} from "../../lib/assistant/provider";
// Paired with MapCanvas so it suspends pointer interaction while dragging.
import {
  PANEL_RESIZE_END_EVENT,
  PANEL_RESIZE_START_EVENT,
} from "../../lib/panel-resize";

const DEFAULT_PANEL_HEIGHT = 360;
const MIN_PANEL_HEIGHT = 160;
const MAX_PANEL_HEIGHT = 640;
const RUNTIME_ENV_EVENT = "geolibre:runtime-env-change";
const PROVIDER_STORAGE_KEY = "geolibre.assistant.provider";
const MODEL_STORAGE_KEY = "geolibre.assistant.model";

/**
 * Providers shown in the no-key setup card, each with the env var(s) that
 * activate it, ordered to mirror `ASSISTANT_PROVIDER_IDS`. Bedrock and custom
 * need all listed vars before configForProvider() resolves them, so both are
 * listed (and rendered as separate chips) rather than leaving the user stuck.
 */
const SETUP_PROVIDERS: ReadonlyArray<{
  id: AssistantProviderId;
  envs: readonly string[];
}> = [
  // Within a row the listed vars are all required (not alternatives), so Google
  // shows only its primary name; GOOGLE_API_KEY / GOOGLE_GENAI_API_KEY also work
  // but listing them as extra chips would wrongly read as "all three required".
  { id: "google", envs: ["GEMINI_API_KEY"] },
  { id: "anthropic", envs: ["ANTHROPIC_API_KEY"] },
  { id: "openai", envs: ["OPENAI_API_KEY"] },
  { id: "ollama", envs: ["OLLAMA_BASE_URL"] },
  { id: "bedrock", envs: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] },
  { id: "custom", envs: ["OPENAI_COMPATIBLE_BASE_URL", "OPENAI_COMPATIBLE_MODEL"] },
];

/** Read a persisted string setting, ignoring storage failures. */
function loadStored(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Persist a string setting; ignore quota/privacy-mode failures. */
function saveStored(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Best-effort persistence only.
  }
}

/** One rendered line in the conversation transcript. */
interface Turn {
  /** Stable, monotonic id — used as the React key and to target updates. */
  id: number;
  role: "user" | "assistant" | "tool" | "error";
  text: string;
  /** Tool name for `role === "tool"`. */
  tool?: string;
  /** Whether a tool call errored. */
  failed?: boolean;
}

interface AssistantPanelProps {
  mapControllerRef: RefObject<MapController | null>;
}

/** Short human-readable summary of a finished tool call. */
function describeTool(name: string, input: unknown): string {
  if (name === "run_sql" && input && typeof input === "object") {
    const sql = (input as { sql?: string }).sql;
    if (sql) return sql;
  }
  if (input && typeof input === "object" && Object.keys(input).length > 0) {
    try {
      return JSON.stringify(input);
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * The natural-language assistant: a bottom-docked chat panel powered by a
 * GeoLibre-native Strands agent. The agent drives the app exclusively through
 * store actions, the SQL Workspace, and the symbology helpers, so every change
 * is reconciled by the normal one-way data flow and covered by undo/redo.
 * Rendered only while open.
 *
 * @param mapControllerRef - Live map controller, read lazily by camera tools.
 */
export function AssistantPanel({ mapControllerRef }: AssistantPanelProps) {
  const { t } = useTranslation();
  const setAssistantOpen = useAppStore((s) => s.setAssistantOpen);

  const sectionRef = useRef<HTMLElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Guards a synchronous double-submit before `running` re-renders.
  const runningRef = useRef(false);
  // Generation that was stopped (0 = none), so a stopped run's rejection isn't
  // shown as an error even after a newer send has started.
  const cancelledGenerationRef = useRef(0);
  // Monotonic id source for transcript turns (stable React keys + update target).
  const turnIdRef = useRef(0);
  // Identifies the current send so a stopped run's cleanup can't reset the
  // running state of a newer send started right after Stop.
  const sendGenerationRef = useRef(0);
  // Tears down an in-flight drag's window listeners if the panel unmounts
  // mid-drag (e.g. the user closes it while dragging).
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  const [height, setHeight] = useState(DEFAULT_PANEL_HEIGHT);

  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [hasKey, setHasKey] = useState(() => hasProviderKey());
  const [providers, setProviders] = useState<AssistantProviderId[]>(() =>
    availableProviders(),
  );
  const [provider, setProvider] = useState<AssistantProviderId | null>(() => {
    const stored = loadStored(PROVIDER_STORAGE_KEY);
    return stored &&
      ASSISTANT_PROVIDER_IDS.includes(stored as AssistantProviderId)
      ? (stored as AssistantProviderId)
      : null;
  });
  const [model, setModel] = useState<string>(
    () => loadStored(MODEL_STORAGE_KEY) ?? "",
  );

  // Queue of model-generated code snippets (run_python / run_maplibre_js)
  // awaiting the user's approval, each with the promise resolver its tool
  // callback is blocked on. A queue (not a single slot) so two tool calls
  // dispatched before the user responds to the first don't drop the first
  // request's resolver — they are shown and resolved one at a time.
  //
  // The ref is authoritative: it's read/drained synchronously (including in the
  // unmount cleanup, where a React state updater is not guaranteed to run and
  // must not carry side effects). The state only mirrors the ref for rendering.
  type PendingCode = {
    id: number;
    tool: "run_python" | "run_maplibre_js";
    code: string;
    resolve: (approved: boolean) => void;
  };
  const codeQueueRef = useRef<PendingCode[]>([]);
  const [codeQueue, setCodeQueue] = useState<PendingCode[]>([]);
  // Once the user opts in, skip the prompt for the rest of this session.
  const alwaysAllowCodeRef = useRef(false);
  // Monotonic id so each queued prompt has a stable React key.
  const codeReqIdRef = useRef(0);

  // Stable (only touches the ref + the stable state setter) so the session
  // useMemo below can depend on it without rebuilding the session each render.
  const commitQueue = useCallback((next: PendingCode[]): void => {
    codeQueueRef.current = next;
    setCodeQueue(next);
  }, []);

  // Resolve the head request and advance the queue. "Always allow" only skips
  // *future* confirmations (via alwaysAllowCodeRef); items already queued behind
  // the head are still surfaced for individual review — otherwise a second,
  // unreviewed snippet the model queued in the same turn would be rubber-stamped.
  const decideCode = (approved: boolean, alwaysAllow: boolean): void => {
    if (approved && alwaysAllow) alwaysAllowCodeRef.current = true;
    const queue = codeQueueRef.current;
    if (queue.length === 0) return;
    const [head, ...rest] = queue;
    head.resolve(approved);
    commitQueue(rest);
  };

  // Decline every queued request (used when the run is stopped/torn down).
  const declineAllPendingCode = (): void => {
    for (const item of codeQueueRef.current) item.resolve(false);
    commitQueue([]);
  };

  // One session per mounted panel; conversation history lives inside it.
  const session = useMemo(
    () =>
      new AssistantSession({
        getMapController: () => mapControllerRef.current,
        // Gate assistant-authored code behind an explicit confirmation (unless
        // the user has opted into always-allow for this session). Prompt-injected
        // content could otherwise make the model run code that exfiltrates data.
        confirmCodeExecution: ({ tool, code }) =>
          alwaysAllowCodeRef.current
            ? Promise.resolve(true)
            : new Promise<boolean>((resolve) => {
                const id = (codeReqIdRef.current += 1);
                commitQueue([
                  ...codeQueueRef.current,
                  { id, tool, code, resolve },
                ]);
              }),
      }),
    [mapControllerRef, commitQueue],
  );

  // Tear down the session and any in-flight run on unmount. Drain the queue ref
  // synchronously (resolving each pending approval as declined) so their blocked
  // tool promises don't hang; done directly on the ref, not via a state updater
  // that may never run after unmount.
  useEffect(
    () => () => {
      session.cancel();
      for (const item of codeQueueRef.current) item.resolve(false);
      codeQueueRef.current = [];
    },
    [session],
  );

  // On unmount mid-drag, tear down the drag's window listeners.
  useEffect(() => () => resizeCleanupRef.current?.(), []);

  // Track which provider keys are configured; rebuild the agent on change so a
  // newly-added key takes effect without reopening the panel.
  useEffect(() => {
    const onEnvChange = () => {
      setHasKey(hasProviderKey());
      setProviders(availableProviders());
    };
    window.addEventListener(RUNTIME_ENV_EVENT, onEnvChange);
    return () => window.removeEventListener(RUNTIME_ENV_EVENT, onEnvChange);
  }, []);

  // Keep the selected provider valid: fall back to the first available one when
  // the stored choice has no key (e.g. its key was removed).
  useEffect(() => {
    if (providers.length === 0) return;
    setProvider((current) =>
      current && providers.includes(current) ? current : providers[0],
    );
  }, [providers]);

  // Push the resolved provider/model into the session. Selecting null lets the
  // session auto-resolve from the configured keys.
  useEffect(() => {
    if (!provider) {
      session.setSelection(null);
      return;
    }
    const models = PROVIDER_MODELS[provider];
    const effectiveModel =
      model && models.includes(model) ? model : defaultModelFor(provider);
    if (effectiveModel !== model) setModel(effectiveModel);
    session.setSelection({ provider, model: effectiveModel });
  }, [provider, model, session]);

  // Keep the latest turn in view. Skip when there is no conversation (e.g. the
  // no-key setup card) so its heading stays pinned to the top instead of being
  // scrolled out of view.
  useEffect(() => {
    if (turns.length === 0) return;
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const send = async () => {
    const prompt = input.trim();
    if (!prompt || runningRef.current || !hasKey) return;
    runningRef.current = true;
    const myGeneration = (sendGenerationRef.current += 1);
    setRunning(true);
    setInput("");
    // Turns are tracked by stable id (not array index), so updaters stay pure —
    // safe under React Strict Mode / concurrent re-invocation — and a stale
    // generator from a stopped/cleared run can no longer corrupt a new one.
    const userId = (turnIdRef.current += 1);
    const assistantId = (turnIdRef.current += 1);
    setTurns((prev) => [
      ...prev,
      { id: userId, role: "user", text: prompt },
      { id: assistantId, role: "assistant", text: "" },
    ]);

    try {
      for await (const event of session.stream(prompt)) {
        if (event.type === "text") {
          setTurns((prev) =>
            prev.map((turn) =>
              turn.id === assistantId
                ? { ...turn, text: turn.text + event.text }
                : turn,
            ),
          );
        } else {
          const label = describeTool(event.name, event.input);
          const detail = event.error
            ? label
              ? `${label} — ${event.error}`
              : event.error
            : label;
          const toolId = (turnIdRef.current += 1);
          setTurns((prev) => {
            const index = prev.findIndex((turn) => turn.id === assistantId);
            // The streaming turn was cleared (Clear/Stop) — drop the late event
            // instead of ghosting it back into an empty transcript.
            if (index < 0) return prev;
            const next = [...prev];
            next.splice(index, 0, {
              id: toolId,
              role: "tool",
              tool: event.name,
              text: detail,
              failed: Boolean(event.error),
            });
            return next;
          });
        }
      }
    } catch (error) {
      // A user-initiated stop rejects the stream; that isn't an error to show.
      // Compare against myGeneration so a newer send can't unmask this older
      // run's cancellation as a failure.
      if (cancelledGenerationRef.current !== myGeneration) {
        const message = error instanceof Error ? error.message : String(error);
        const errorId = (turnIdRef.current += 1);
        setTurns((prev) => [...prev, { id: errorId, role: "error", text: message }]);
      }
    } finally {
      // Drop the assistant turn if it never produced text (e.g. tool-only run).
      setTurns((prev) =>
        prev.filter(
          (turn) =>
            !(turn.id === assistantId && turn.role === "assistant" && !turn.text),
        ),
      );
      // Only clear the running state if no newer send has superseded this one
      // (e.g. the user stopped and immediately sent again).
      if (sendGenerationRef.current === myGeneration) {
        runningRef.current = false;
        setRunning(false);
      }
    }
  };

  const stop = () => {
    cancelledGenerationRef.current = sendGenerationRef.current;
    session.cancel();
    // Decline any code awaiting approval so a stopped run doesn't leave the
    // confirmation prompt (and its blocked tool promises) hanging.
    declineAllPendingCode();
    runningRef.current = false;
    setRunning(false);
  };

  // Clear the transcript and the agent's conversation history (so the next
  // message starts fresh), stopping any in-flight run first.
  const clearConversation = () => {
    stop();
    setTurns([]);
    session.reset();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  };

  const onProviderChange = (value: AssistantProviderId) => {
    setProvider(value);
    setModel("");
    saveStored(PROVIDER_STORAGE_KEY, value);
    saveStored(MODEL_STORAGE_KEY, "");
  };

  const onModelChange = (value: string) => {
    setModel(value);
    saveStored(MODEL_STORAGE_KEY, value);
  };

  // Drag the top edge to resize the panel height. Mirrors the Python Console:
  // writes are throttled to one DOM mutation per frame and committed to state on
  // mouseup, and the panel-resize events let MapCanvas pause pointer handling.
  const startResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    const startHeight = height;
    let nextHeight = startHeight;
    let frame: number | null = null;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.dispatchEvent(new Event(PANEL_RESIZE_START_EVENT));

    const onMove = (moveEvent: MouseEvent) => {
      const available = Math.max(MIN_PANEL_HEIGHT, window.innerHeight - 180);
      const maxHeight = Math.min(MAX_PANEL_HEIGHT, available);
      nextHeight = Math.min(
        maxHeight,
        Math.max(MIN_PANEL_HEIGHT, startHeight + startY - moveEvent.clientY),
      );
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (sectionRef.current) {
          sectionRef.current.style.height = `${nextHeight}px`;
        }
      });
    };

    const finish = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", finish);
      resizeCleanupRef.current = null;
      if (frame !== null) window.cancelAnimationFrame(frame);
      setHeight(nextHeight);
      window.dispatchEvent(new Event(PANEL_RESIZE_END_EVENT));
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", finish);
    resizeCleanupRef.current = finish;
  };

  // Show the onboarding setup card only when no provider is configured, no run
  // is in flight, and there is no conversation to preserve. Gating on `running`
  // keeps the Stop button reachable if a key is removed mid-run; gating on
  // `turns.length` keeps a finished conversation visible afterwards instead of
  // hiding it behind the setup card (it returns when the user clears the chat).
  const showSetup = !hasKey && !running && turns.length === 0;

  // When the panel leaves the setup card for the chat input (e.g. the user just
  // added their first provider key), focus the input so they can type at once.
  const prevShowSetupRef = useRef(showSetup);
  useEffect(() => {
    if (prevShowSetupRef.current && !showSetup) inputRef.current?.focus();
    prevShowSetupRef.current = showSetup;
  }, [showSetup]);

  return (
    <section
      ref={sectionRef}
      aria-label={t("assistant.title")}
      className="relative flex shrink-0 flex-col border-t bg-card"
      style={{ height }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("assistant.resize")}
        className="absolute -top-1 left-0 right-0 z-20 h-2 cursor-row-resize select-none border-t border-transparent hover:border-primary"
        onMouseDown={startResize}
      />
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <Sparkles className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">{t("assistant.title")}</span>
        {running ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("assistant.thinking")}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {hasKey && provider && providers.length > 0 ? (
            <>
              {providers.length > 1 ? (
                <Select
                  aria-label={t("assistant.provider")}
                  className="h-8 w-auto text-xs"
                  value={provider}
                  disabled={running}
                  onChange={(event) =>
                    onProviderChange(event.target.value as AssistantProviderId)
                  }
                >
                  {providers.map((id) => (
                    <option key={id} value={id}>
                      {PROVIDER_LABELS[id]}
                    </option>
                  ))}
                </Select>
              ) : null}
              {PROVIDER_MODELS[provider].length > 0 ? (
                <Select
                  aria-label={t("assistant.model")}
                  className="h-8 w-auto text-xs"
                  value={model || defaultModelFor(provider)}
                  disabled={running}
                  onChange={(event) => onModelChange(event.target.value)}
                >
                  {PROVIDER_MODELS[provider].map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </Select>
              ) : null}
            </>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title={t("assistant.clear")}
            onClick={clearConversation}
          >
            <Eraser className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title={t("assistant.close")}
            onClick={() => setAssistantOpen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div
        ref={outputRef}
        className="flex-1 space-y-2 overflow-auto px-3 py-2 text-sm leading-relaxed"
      >
        {showSetup ? (
          // No provider yet: show only the setup card. The capability blurb and
          // input box stay hidden until a provider is configured, so we never
          // invite a prompt the assistant can't run (issue #547). The action
          // button lives in the footer below so it stays visible if the list
          // grows past the panel height.
          <div className="mx-auto flex max-w-md flex-col gap-2.5">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 shrink-0 text-primary" />
              <p className="font-medium text-foreground">
                {t("assistant.setupTitle")}
              </p>
            </div>
            <p className="text-muted-foreground">{t("assistant.setupStatus")}</p>
            <div className="rounded-md border bg-muted/40 p-2">
              <p className="mb-1.5 text-xs font-medium text-foreground">
                {t("assistant.setupProviders")}
              </p>
              <ul aria-label={t("assistant.setupProviders")} className="space-y-1">
                {SETUP_PROVIDERS.map(({ id, envs }) => (
                  <li
                    key={id}
                    className="flex items-start justify-between gap-3 text-xs"
                  >
                    <span className="shrink-0 text-foreground">
                      {PROVIDER_LABELS[id]}
                    </span>
                    {/* One chip per variable so a multi-credential provider
                        never reads as a single oddly-named env var. */}
                    <span className="flex flex-wrap justify-end gap-x-1 gap-y-0.5 text-right font-mono text-[11px] text-muted-foreground">
                      {envs.map((name, index) => (
                        <span key={name} className="whitespace-nowrap">
                          {index > 0 ? (
                            <span className="mr-1 text-muted-foreground/60">
                              +
                            </span>
                          ) : null}
                          <code>{name}</code>
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : turns.length === 0 ? (
          <p className="text-muted-foreground">{t("assistant.intro")}</p>
        ) : (
          turns.map((turn) => {
            if (turn.role === "tool") {
              return (
                <div
                  key={turn.id}
                  className={cn(
                    "flex items-start gap-1.5 font-mono text-xs",
                    turn.failed ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  <Wrench className="mt-0.5 h-3 w-3 shrink-0" />
                  <span className="break-all">
                    <span className="font-semibold">{turn.tool}</span>
                    {turn.text ? ` · ${turn.text}` : ""}
                  </span>
                </div>
              );
            }
            if (turn.role === "error") {
              return (
                <p
                  key={turn.id}
                  className="flex items-start gap-1.5 text-xs text-destructive"
                >
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{turn.text}</span>
                </p>
              );
            }
            if (turn.role === "user") {
              return (
                <div
                  key={turn.id}
                  className="whitespace-pre-wrap font-medium text-foreground"
                >
                  {`❯ ${turn.text}`}
                </div>
              );
            }
            // Assistant replies are markdown — render (and sanitize) them.
            return (
              <div
                key={turn.id}
                className={cn(
                  "text-foreground",
                  "[&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
                  "[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5",
                  "[&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5",
                  "[&_a]:text-primary [&_a]:underline",
                  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs",
                  "[&_pre]:my-1 [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2",
                  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
                )}
                dangerouslySetInnerHTML={{
                  __html: renderAssistantMarkdown(turn.text),
                }}
              />
            );
          })
        )}
      </div>

      {showSetup ? (
        // Keep the call to action pinned to the bottom so it is reachable even
        // when the provider list scrolls.
        <div className="border-t px-3 py-2">
          <Button
            size="sm"
            className="w-full"
            onClick={() => openSettingsSection("ai")}
          >
            <Settings className="mr-1 h-4 w-4" />
            {t("assistant.setupOpenSettings")}
          </Button>
        </div>
      ) : (
        <div className="flex items-end gap-2 border-t px-3 py-2">
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("assistant.placeholder")}
            spellCheck
            rows={2}
            // Stays disabled if the key is removed mid-run; the Stop button is a
            // separate control, so it remains reachable until the run ends.
            disabled={!hasKey}
            className="min-h-[2.5rem] flex-1 resize-none text-sm"
          />
          {running ? (
            <Button
              size="sm"
              variant="outline"
              onClick={stop}
              title={t("assistant.stop")}
            >
              <Square className="mr-1 h-4 w-4" />
              {t("assistant.stop")}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => void send()}
              disabled={!hasKey || !input.trim()}
              title={t("assistant.sendHint")}
            >
              <Send className="mr-1 h-4 w-4" />
              {t("assistant.send")}
            </Button>
          )}
        </div>
      )}

      {codeQueue.length > 0 ? (
        <CodeApprovalOverlay
          key={codeQueue[0].id}
          tool={codeQueue[0].tool}
          code={codeQueue[0].code}
          onDecide={decideCode}
        />
      ) : null}
    </section>
  );
}

/**
 * Modal shown before the assistant runs a `run_python` / `run_maplibre_js`
 * snippet. Displays the code and requires an explicit decision, with an opt-in
 * to skip the prompt for the rest of the session.
 */
function CodeApprovalOverlay({
  tool,
  code,
  onDecide,
}: {
  tool: "run_python" | "run_maplibre_js";
  code: string;
  onDecide: (approved: boolean, alwaysAllow: boolean) => void;
}) {
  const { t } = useTranslation();
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const language = tool === "run_python" ? "Python" : "JavaScript";
  // Move focus to the safe default (Decline) when the prompt opens so keyboard
  // users land inside the dialog, and let Escape dismiss it as a decline.
  const dialogRef = useRef<HTMLDivElement>(null);
  const declineRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    declineRef.current?.focus();
  }, []);
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/80 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("assistant.codeApprovalTitle")}
        className="flex max-h-full w-full max-w-md flex-col gap-3 rounded-lg border bg-card p-4 shadow-lg"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onDecide(false, false);
            return;
          }
          // Trap Tab within this security-critical dialog so a keyboard user
          // can't move focus to background controls while the prompt is open.
          if (event.key === "Tab") {
            const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
              'button, input, [href], [tabindex]:not([tabindex="-1"])',
            );
            if (!focusables || focusables.length === 0) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            const active = document.activeElement;
            if (event.shiftKey && active === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && active === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-amber-500" />
          <span className="text-sm font-semibold">
            {t("assistant.codeApprovalTitle")}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("assistant.codeApprovalBody", { language })}
        </p>
        <pre className="max-h-48 overflow-auto rounded border bg-muted p-2 text-xs">
          <code>{code}</code>
        </pre>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={alwaysAllow}
            onChange={(event) => setAlwaysAllow(event.target.checked)}
          />
          {t("assistant.codeApprovalAlways")}
        </label>
        <div className="flex justify-end gap-2">
          <Button
            ref={declineRef}
            size="sm"
            variant="outline"
            onClick={() => onDecide(false, false)}
          >
            {t("assistant.codeApprovalDecline")}
          </Button>
          <Button size="sm" onClick={() => onDecide(true, alwaysAllow)}>
            {t("assistant.codeApprovalRun")}
          </Button>
        </div>
      </div>
    </div>
  );
}
