import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { Button, Textarea } from "@geolibre/ui";
import {
  Eraser,
  Loader2,
  PanelLeft,
  PanelLeftClose,
  Play,
  Terminal,
  X,
} from "lucide-react";
import {
  type ChangeEvent as ReactChangeEvent,
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
import { usePyCompletion } from "../../lib/pyodide/usePyCompletion";
import { PythonEditorPane } from "./PythonEditorPane";

const DEFAULT_CONSOLE_HEIGHT = 240;
const MIN_CONSOLE_HEIGHT = 120;
const MAX_CONSOLE_HEIGHT = 560;
const DEFAULT_EDITOR_WIDTH = 360;
const MIN_EDITOR_WIDTH = 220;
const MAX_EDITOR_WIDTH = 900;
const PANEL_RESIZE_START_EVENT = "geolibre:panel-resize-start";
const PANEL_RESIZE_END_EVENT = "geolibre:panel-resize-end";

type EntryKind = "input" | "output" | "error" | "marker";
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
 * app. A "Show Editor" toggle splits in a script editor (left) that shares the
 * same interpreter, à la QGIS. Rendered only while open.
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
  const consoleInputRef = useRef<HTMLTextAreaElement>(null);
  const editorPaneRef = useRef<HTMLDivElement>(null);
  // Tear down an in-flight drag's window listeners; set while dragging so an
  // unmount mid-drag (e.g. closing the panel) doesn't leak them. One per drag
  // axis so a second drag can't overwrite the other's cleanup.
  const verticalResizeCleanupRef = useRef<(() => void) | null>(null);
  const horizontalResizeCleanupRef = useRef<(() => void) | null>(null);
  // Caret to apply after a programmatic console-input change (history recall).
  const historyCaretRef = useRef<number | null>(null);
  // Submitted commands (newest last) for up/down recall, plus the cursor into
  // them and the draft saved when history navigation begins.
  const commandHistoryRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number | null>(null);
  const historyDraftRef = useRef("");
  const [height, setHeight] = useState(DEFAULT_CONSOLE_HEIGHT);
  const [editorVisible, setEditorVisible] = useState(false);
  const [editorWidth, setEditorWidth] = useState(DEFAULT_EDITOR_WIDTH);
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

  const completion = usePyCompletion({
    textareaRef: consoleInputRef,
    code,
    setCode,
    deps,
    ready,
    label: t("pythonConsole.completions"),
  });

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

  // Apply a queued caret position after a history recall changes `code`.
  useEffect(() => {
    if (historyCaretRef.current === null) return;
    const pos = historyCaretRef.current;
    historyCaretRef.current = null;
    const ta = consoleInputRef.current;
    if (ta) ta.setSelectionRange(pos, pos);
  }, [code]);

  // Shared runner: execute Python in the one runtime and append output/errors to
  // the console scrollback. Used by both the console input and the editor, so
  // their variables are shared (same interpreter).
  const runSource = async (source: string) => {
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

  // Run the editor's script, prefixed by a marker line in the scrollback.
  const runScript = async (source: string, label: string) => {
    if (!source.trim() || running) return;
    setHistory((h) => [...h, { kind: "marker", text: `# ▶ ${label}` }]);
    await runSource(source);
  };

  const run = async () => {
    const source = code.trim();
    if (!source || running) return;
    const cmds = commandHistoryRef.current;
    if (cmds[cmds.length - 1] !== source) cmds.push(source);
    historyIndexRef.current = null;
    completion.close();
    setHistory((h) => [...h, { kind: "input", text: source }]);
    setCode("");
    await runSource(source);
  };

  // Recall a previous command. dir -1 = older, +1 = newer. Only navigates when
  // the caret is on the first line (older) or last line (newer). Returns true
  // when handled.
  const navigateHistory = (dir: -1 | 1): boolean => {
    const ta = consoleInputRef.current;
    const cmds = commandHistoryRef.current;
    if (!ta || cmds.length === 0) return false;
    const pos = ta.selectionStart ?? 0;
    if (dir === -1) {
      if (code.slice(0, pos).includes("\n")) return false;
      if (historyIndexRef.current === null) {
        historyDraftRef.current = code;
        historyIndexRef.current = cmds.length - 1;
      } else if (historyIndexRef.current > 0) {
        historyIndexRef.current -= 1;
      } else {
        return true; // already at the oldest; consume to avoid a caret jump
      }
    } else {
      if (historyIndexRef.current === null) return false;
      if (code.slice(pos).includes("\n")) return false;
      if (historyIndexRef.current < cmds.length - 1) {
        historyIndexRef.current += 1;
      } else {
        historyIndexRef.current = null; // past newest → restore the draft
      }
    }
    const text =
      historyIndexRef.current === null
        ? historyDraftRef.current
        : cmds[historyIndexRef.current];
    historyCaretRef.current = text.length;
    setCode(text);
    return true;
  };

  const onConsoleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (completion.tryKey(event)) return;
    // Ctrl/Cmd+Enter runs; plain Enter inserts a newline (multi-line editing).
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void run();
      return;
    }
    if (event.key === "ArrowUp" && navigateHistory(-1)) {
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowDown" && navigateHistory(1)) {
      event.preventDefault();
    }
  };

  const onConsoleChange = (
    event: ReactChangeEvent<HTMLTextAreaElement>,
  ) => {
    setCode(event.target.value);
    historyIndexRef.current = null;
    completion.close();
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
      verticalResizeCleanupRef.current = null;
      if (frame !== null) window.cancelAnimationFrame(frame);
      setHeight(nextHeight);
      window.dispatchEvent(new Event(PANEL_RESIZE_END_EVENT));
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    verticalResizeCleanupRef.current = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (frame !== null) window.cancelAnimationFrame(frame);
      // Pair the START dispatched on mousedown, so MapCanvas clears
      // panelResizeActive even when unmounted mid-drag.
      window.dispatchEvent(new Event(PANEL_RESIZE_END_EVENT));
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  };

  // Horizontal splitter between the editor (left) and the console (right).
  const startEditorResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = editorWidth;
    let nextWidth = startWidth;
    let frame: number | null = null;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (moveEvent: MouseEvent) => {
      nextWidth = Math.min(
        MAX_EDITOR_WIDTH,
        Math.max(MIN_EDITOR_WIDTH, startWidth + moveEvent.clientX - startX),
      );
      // Throttle to one DOM write per frame; commit to state only on mouseup.
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (editorPaneRef.current) {
          editorPaneRef.current.style.width = `${nextWidth}px`;
        }
      });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      horizontalResizeCleanupRef.current = null;
      if (frame !== null) window.cancelAnimationFrame(frame);
      setEditorWidth(nextWidth);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    horizontalResizeCleanupRef.current = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (frame !== null) window.cancelAnimationFrame(frame);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  };

  // On unmount, tear down any in-flight drag listeners (either axis).
  useEffect(
    () => () => {
      verticalResizeCleanupRef.current?.();
      horizontalResizeCleanupRef.current?.();
    },
    [],
  );

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
            variant={editorVisible ? "secondary" : "ghost"}
            size="icon"
            className="h-8 w-8"
            title={
              editorVisible
                ? t("pythonConsole.hideEditor")
                : t("pythonConsole.showEditor")
            }
            aria-pressed={editorVisible}
            onClick={() => setEditorVisible((v) => !v)}
          >
            {editorVisible ? (
              <PanelLeftClose className="h-4 w-4" />
            ) : (
              <PanelLeft className="h-4 w-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title={t("pythonConsole.clear")}
            onClick={() => setHistory([])}
          >
            <Eraser className="h-4 w-4" />
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

      <div className="flex min-h-0 flex-1">
        {editorVisible ? (
          <>
            <div
              ref={editorPaneRef}
              className="flex min-w-0 flex-col border-r"
              style={{ width: editorWidth }}
            >
              <PythonEditorPane
                deps={deps}
                ready={ready}
                running={running}
                runScript={runScript}
                completionLabel={t("pythonConsole.completions")}
              />
            </div>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t("pythonConsole.resizeEditor")}
              className="w-1 shrink-0 cursor-col-resize select-none bg-border hover:bg-primary"
              onMouseDown={startEditorResize}
            />
          </>
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
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
                        : entry.kind === "marker"
                          ? "text-muted-foreground"
                          : "text-foreground"
                  }
                >
                  {entry.kind === "input" ? `>>> ${entry.text}` : entry.text}
                </div>
              ))
            )}
          </div>

          <div className="relative flex items-end gap-2 border-t px-3 py-2">
            {completion.dropdown}
            <Textarea
              ref={consoleInputRef}
              value={code}
              onChange={onConsoleChange}
              onKeyDown={onConsoleKeyDown}
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
        </div>
      </div>
    </section>
  );
}
