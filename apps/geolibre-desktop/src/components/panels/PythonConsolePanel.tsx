import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { Button, Textarea } from "@geolibre/ui";
import { Loader2, Play, Terminal, Trash2, X } from "lucide-react";
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
import {
  consoleDeps,
  initConsoleRuntime,
  onConsoleProgress,
  runConsoleCode,
} from "../../lib/pyodide/pyodide-console";

const DEFAULT_CONSOLE_HEIGHT = 240;
const MIN_CONSOLE_HEIGHT = 120;
const MAX_CONSOLE_HEIGHT = 560;
const PANEL_RESIZE_START_EVENT = "geolibre:panel-resize-start";
const PANEL_RESIZE_END_EVENT = "geolibre:panel-resize-end";

type EntryKind = "input" | "output" | "error";
interface Entry {
  kind: EntryKind;
  text: string;
}

interface PythonConsolePanelProps {
  mapControllerRef: RefObject<MapController | null>;
}

/**
 * The in-app Python Console: a bottom-docked, resizable panel that runs Python
 * via main-thread Pyodide and exposes a `geolibre` object that drives the live
 * app (mirrors the docked AttributeTable pattern). Rendered only while open.
 *
 * @param mapControllerRef - Ref to the live map controller, read lazily by the
 *   Pyodide `geolibre` facade so Python can drive the current map.
 */
export function PythonConsolePanel({
  mapControllerRef,
}: PythonConsolePanelProps) {
  const { t } = useTranslation();
  const setPythonConsoleOpen = useAppStore((s) => s.setPythonConsoleOpen);

  const sectionRef = useRef<HTMLElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  // Tears down an in-flight drag's window listeners; set while dragging so an
  // unmount mid-drag (e.g. closing the panel) doesn't leak them.
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [height, setHeight] = useState(DEFAULT_CONSOLE_HEIGHT);
  const [code, setCode] = useState("");
  const [history, setHistory] = useState<Entry[]>([]);
  const [running, setRunning] = useState(false);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const deps = useMemo(
    () => consoleDeps(() => mapControllerRef.current),
    [mapControllerRef],
  );

  // Lazily boot the runtime the first time the panel opens, surfacing the
  // download/setup phases. The runtime is a module singleton, so a later reopen
  // resolves immediately and keeps the user's variables.
  useEffect(() => {
    const off = onConsoleProgress(setStatus);
    let cancelled = false;
    initConsoleRuntime(deps)
      .then(() => {
        if (cancelled) return;
        setReady(true);
        setStatus(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setStatus(null);
        setLoadError(
          error instanceof Error
            ? error.message
            : t("pythonConsole.loadFailed"),
        );
      });
    return () => {
      cancelled = true;
      off();
    };
  }, [deps, t]);

  // Keep the latest output in view.
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history]);

  const run = async () => {
    const source = code.trim();
    if (!source || running) return;
    setHistory((h) => [...h, { kind: "input", text: source }]);
    setCode("");
    setRunning(true);
    try {
      const { output, error } = await runConsoleCode(deps, source);
      setHistory((h) => [
        ...h,
        ...(output ? [{ kind: "output" as const, text: output }] : []),
        ...(error ? [{ kind: "error" as const, text: error }] : []),
      ]);
    } catch (error) {
      setHistory((h) => [
        ...h,
        {
          kind: "error",
          text: error instanceof Error ? error.message : String(error),
        },
      ]);
    } finally {
      setRunning(false);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl/Cmd+Enter runs; plain Enter inserts a newline (multi-line editing).
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void run();
    }
  };

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
      const available = Math.max(MIN_CONSOLE_HEIGHT, window.innerHeight - 180);
      const maxHeight = Math.min(MAX_CONSOLE_HEIGHT, available);
      nextHeight = Math.min(
        maxHeight,
        Math.max(MIN_CONSOLE_HEIGHT, startHeight + startY - moveEvent.clientY),
      );
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (sectionRef.current) {
          sectionRef.current.style.height = `${nextHeight}px`;
        }
      });
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      resizeCleanupRef.current = null;
      if (frame !== null) window.cancelAnimationFrame(frame);
      setHeight(nextHeight);
      window.dispatchEvent(new Event(PANEL_RESIZE_END_EVENT));
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    // Expose teardown so an unmount during the drag can remove the listeners.
    resizeCleanupRef.current = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (frame !== null) window.cancelAnimationFrame(frame);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  };

  // On unmount, tear down any in-flight drag listeners.
  useEffect(() => () => resizeCleanupRef.current?.(), []);

  return (
    <section
      ref={sectionRef}
      aria-label={t("pythonConsole.title")}
      className="relative flex shrink-0 flex-col border-t bg-card"
      style={{ height }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("pythonConsole.resize")}
        className="absolute -top-1 left-0 right-0 z-20 h-2 cursor-row-resize select-none border-t border-transparent hover:border-primary"
        onMouseDown={startResize}
      />
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <Terminal className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">{t("pythonConsole.title")}</span>
        {loadError ? (
          <span className="text-xs text-destructive">{loadError}</span>
        ) : status ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {status}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title={t("pythonConsole.clear")}
            onClick={() => setHistory([])}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title={t("pythonConsole.close")}
            onClick={() => setPythonConsoleOpen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div
        ref={outputRef}
        className="flex-1 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-relaxed"
      >
        {history.length === 0 ? (
          <p className="text-muted-foreground">{t("pythonConsole.intro")}</p>
        ) : (
          history.map((entry, index) => (
            <div
              key={index}
              className={
                entry.kind === "input"
                  ? "text-primary"
                  : entry.kind === "error"
                    ? "text-destructive"
                    : "text-foreground"
              }
            >
              {entry.kind === "input" ? `>>> ${entry.text}` : entry.text}
            </div>
          ))
        )}
      </div>

      <div className="flex items-end gap-2 border-t px-3 py-2">
        <Textarea
          value={code}
          onChange={(event) => setCode(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("pythonConsole.placeholder")}
          spellCheck={false}
          rows={2}
          className="min-h-[2.5rem] flex-1 resize-none font-mono text-xs"
        />
        <Button
          size="sm"
          onClick={() => void run()}
          disabled={running || !ready || !code.trim()}
          title={t("pythonConsole.runHint")}
        >
          {running ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <Play className="mr-1 h-4 w-4" />
          )}
          {t("pythonConsole.run")}
        </Button>
      </div>
    </section>
  );
}
