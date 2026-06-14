import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { Button, Textarea, cn } from "@geolibre/ui";
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
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { AssistantSession } from "../../lib/assistant/agent";
import { hasProviderKey } from "../../lib/assistant/provider";

const PANEL_HEIGHT = 360;
const RUNTIME_ENV_EVENT = "geolibre:runtime-env-change";

/** One rendered line in the conversation transcript. */
interface Turn {
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

  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Guards a synchronous double-submit before `running` re-renders.
  const runningRef = useRef(false);

  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [hasKey, setHasKey] = useState(() => hasProviderKey());

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

  // Track whether a provider key is configured; rebuild the agent on change so
  // a newly-added key takes effect without reopening the panel.
  useEffect(() => {
    const onEnvChange = () => {
      setHasKey(hasProviderKey());
      session.reset();
    };
    window.addEventListener(RUNTIME_ENV_EVENT, onEnvChange);
    return () => window.removeEventListener(RUNTIME_ENV_EVENT, onEnvChange);
  }, [session]);

  // Keep the latest turn in view.
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const send = async () => {
    const prompt = input.trim();
    if (!prompt || runningRef.current || !hasKey) return;
    runningRef.current = true;
    setRunning(true);
    setInput("");
    setTurns((prev) => [...prev, { role: "user", text: prompt }]);
    // Reserve a streaming assistant turn whose text we append into.
    let assistantIndex = -1;
    setTurns((prev) => {
      assistantIndex = prev.length;
      return [...prev, { role: "assistant", text: "" }];
    });

    try {
      for await (const event of session.stream(prompt)) {
        if (event.type === "text") {
          setTurns((prev) => {
            const next = [...prev];
            const turn = next[assistantIndex];
            if (turn) next[assistantIndex] = { ...turn, text: turn.text + event.text };
            return next;
          });
        } else {
          // Insert a tool line before the streaming assistant turn.
          const detail = event.error
            ? `${describeTool(event.name, event.input)} — ${event.error}`.trim()
            : describeTool(event.name, event.input);
          setTurns((prev) => {
            const next = [...prev];
            next.splice(assistantIndex, 0, {
              role: "tool",
              tool: event.name,
              text: detail,
              failed: Boolean(event.error),
            });
            assistantIndex += 1;
            return next;
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTurns((prev) => [...prev, { role: "error", text: message }]);
    } finally {
      // Drop an empty assistant turn (e.g. a run that only made tool calls).
      setTurns((prev) =>
        prev.filter(
          (turn, index) =>
            !(index === assistantIndex && turn.role === "assistant" && !turn.text),
        ),
      );
      runningRef.current = false;
      setRunning(false);
    }
  };

  const stop = () => {
    session.cancel();
    runningRef.current = false;
    setRunning(false);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <section
      aria-label={t("assistant.title")}
      className="relative flex shrink-0 flex-col border-t bg-card"
      style={{ height: PANEL_HEIGHT }}
    >
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
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title={t("assistant.clear")}
            onClick={() => setTurns([])}
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
          turns.map((turn, index) => {
            if (turn.role === "tool") {
              return (
                <div
                  key={index}
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
                  key={index}
                  className="flex items-start gap-1.5 text-xs text-destructive"
                >
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{turn.text}</span>
                </p>
              );
            }
            return (
              <div
                key={index}
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
