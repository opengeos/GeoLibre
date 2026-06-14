import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { Button, Select, Textarea, cn } from "@geolibre/ui";
import {
  AlertCircle,
  Eraser,
  Loader2,
  Send,
  Sparkles,
  Square,
  Wrench,
  X,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { AssistantSession } from "../../lib/assistant/agent";
import {
  availableProviders,
  defaultModelFor,
  hasProviderKey,
  PROVIDER_LABELS,
  PROVIDER_MODELS,
  type AssistantProviderId,
} from "../../lib/assistant/provider";

const DEFAULT_PANEL_HEIGHT = 360;
const MIN_PANEL_HEIGHT = 160;
const MAX_PANEL_HEIGHT = 640;
const RUNTIME_ENV_EVENT = "geolibre:runtime-env-change";
// Paired with MapCanvas so it suspends pointer interaction while dragging.
const PANEL_RESIZE_START_EVENT = "geolibre:panel-resize-start";
const PANEL_RESIZE_END_EVENT = "geolibre:panel-resize-end";
const PROVIDER_STORAGE_KEY = "geolibre.assistant.provider";
const MODEL_STORAGE_KEY = "geolibre.assistant.model";
const PROVIDER_IDS: readonly AssistantProviderId[] = [
  "google",
  "anthropic",
  "openai",
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
  // Set true by Stop/Clear so the stream's rejection isn't shown as an error.
  const cancelledRef = useRef(false);
  // Monotonic id source for transcript turns (stable React keys + update target).
  const turnIdRef = useRef(0);
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
    return stored && PROVIDER_IDS.includes(stored as AssistantProviderId)
      ? (stored as AssistantProviderId)
      : null;
  });
  const [model, setModel] = useState<string>(
    () => loadStored(MODEL_STORAGE_KEY) ?? "",
  );

  // One session per mounted panel; conversation history lives inside it.
  const session = useMemo(
    () =>
      new AssistantSession({
        getMapController: () => mapControllerRef.current,
      }),
    [mapControllerRef],
  );

  // Tear down the session and any in-flight run on unmount.
  useEffect(() => () => session.cancel(), [session]);

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

  // Keep the latest turn in view.
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const send = async () => {
    const prompt = input.trim();
    if (!prompt || runningRef.current || !hasKey) return;
    runningRef.current = true;
    cancelledRef.current = false;
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
          const detail = event.error
            ? `${describeTool(event.name, event.input)} — ${event.error}`.trim()
            : describeTool(event.name, event.input);
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
      if (!cancelledRef.current) {
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
      runningRef.current = false;
      setRunning(false);
    }
  };

  const stop = () => {
    cancelledRef.current = true;
    session.cancel();
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
        {turns.length === 0 ? (
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
            return (
              <div
                key={turn.id}
                className={cn(
                  "whitespace-pre-wrap",
                  turn.role === "user"
                    ? "font-medium text-foreground"
                    : "text-foreground",
                )}
              >
                {turn.role === "user" ? `❯ ${turn.text}` : turn.text}
              </div>
            );
          })
        )}
      </div>

      {!hasKey ? (
        <p className="border-t bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {t("assistant.needsKey")}
        </p>
      ) : null}

      <div className="flex items-end gap-2 border-t px-3 py-2">
        <Textarea
          ref={inputRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("assistant.placeholder")}
          spellCheck
          rows={2}
          disabled={!hasKey}
          className="min-h-[2.5rem] flex-1 resize-none text-sm"
        />
        {running ? (
          <Button size="sm" variant="outline" onClick={stop} title={t("assistant.stop")}>
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
    </section>
  );
}
