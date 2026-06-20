import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { Button, Textarea } from "@geolibre/ui";
import { Code2, Eraser, Loader2, Play, Terminal, X } from "lucide-react";
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
const DEFAULT_EDITOR_HEIGHT = 200;
const MIN_EDITOR_HEIGHT = 120;
// Room reserved for the terminal (plus header and divider chrome) when the
// advanced editor grows via the splitter or the panel-grow on toggle. In
// advanced mode the outer panel's minimum height is raised to
// MIN_EDITOR_HEIGHT + this, so the terminal keeps this much room and never
// collapses to zero (see startResize).
const EDITOR_RESIZE_RESERVE = 150;
// Keyboard step for the editor splitter (ArrowUp/ArrowDown).
const EDITOR_RESIZE_STEP = 24;
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
 * app. A single input region sits below the output terminal and toggles between
 * two modes that share the one interpreter: Basic (a single-line REPL) and
 * Advanced (a full-width, QGIS-style script editor that grows upward and adds
 * New/Open/Save tools). Rendered only while open.
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
  const editorRegionRef = useRef<HTMLDivElement>(null);
  // Tear down an in-flight drag's window listeners; set while dragging so an
  // unmount mid-drag (e.g. closing the panel) doesn't leak them. One per drag
  // axis so a second drag can't overwrite the other's cleanup.
  const verticalResizeCleanupRef = useRef<(() => void) | null>(null);
  const editorResizeCleanupRef = useRef<(() => void) | null>(null);
  // Caret to apply after a programmatic console-input change (history recall).
  const historyCaretRef = useRef<number | null>(null);
  // Submitted commands (newest last) for up/down recall, plus the cursor into
  // them and the draft saved when history navigation begins.
  const commandHistoryRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number | null>(null);
  const historyDraftRef = useRef("");
  const [height, setHeight] = useState(DEFAULT_CONSOLE_HEIGHT);
  const [advancedMode, setAdvancedMode] = useState(false);
  const [editorHeight, setEditorHeight] = useState(DEFAULT_EDITOR_HEIGHT);
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

  // Toggle the single input region between the basic REPL and the advanced
  // editor. Entering advanced grows the panel so the editor gets its room
  // without crushing the output terminal to a sliver. Both setState calls stay
  // at the top level (no side effect inside an updater); reading advancedMode
  // from the closure is safe in an event handler.
  const toggleAdvanced = () => {
    if (!advancedMode) {
      setHeight((h) =>
        Math.min(
          MAX_CONSOLE_HEIGHT,
          Math.max(h, editorHeight + EDITOR_RESIZE_RESERVE),
        ),
      );
    } else {
      // Leaving advanced unmounts the editor; move focus to the REPL input that
      // replaces it (deferred until after it renders).
      requestAnimationFrame(() => consoleInputRef.current?.focus());
    }
    setAdvancedMode((prev) => !prev);
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
    // In advanced mode keep the panel tall enough that the fixed-height editor
    // can't push the terminal to zero: MIN_CONSOLE_HEIGHT on its own is shorter
    // than the editor's minimum plus the terminal's reserve.
    const minPanelHeight = advancedMode
      ? Math.min(MIN_EDITOR_HEIGHT + EDITOR_RESIZE_RESERVE, MAX_CONSOLE_HEIGHT)
      : MIN_CONSOLE_HEIGHT;

    const onMove = (moveEvent: MouseEvent) => {
      const available = Math.max(minPanelHeight, window.innerHeight - 180);
      const maxHeight = Math.min(MAX_CONSOLE_HEIGHT, available);
      nextHeight = Math.min(
        maxHeight,
        Math.max(minPanelHeight, startHeight + startY - moveEvent.clientY),
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

  // Splitter between the output terminal (top) and the advanced editor (bottom);
  // dragging up grows the editor, clamped so the terminal keeps a usable height.
  const startEditorResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    // Seed from the actual rendered height (the render-time clamp may hold it
    // below editorHeight when the panel is short) so the drag has no dead-zone.
    const startHeight = editorRegionRef.current?.clientHeight ?? editorHeight;
    let nextHeight = startHeight;
    let frame: number | null = null;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    const onMove = (moveEvent: MouseEvent) => {
      const panelHeight = sectionRef.current?.clientHeight ?? height;
      const maxHeight = Math.max(
        MIN_EDITOR_HEIGHT,
        panelHeight - EDITOR_RESIZE_RESERVE,
      );
      nextHeight = Math.min(
        maxHeight,
        Math.max(MIN_EDITOR_HEIGHT, startHeight + startY - moveEvent.clientY),
      );
      // Throttle to one DOM write per frame; commit to state only on mouseup.
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (editorRegionRef.current) {
          editorRegionRef.current.style.height = `${nextHeight}px`;
        }
      });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      editorResizeCleanupRef.current = null;
      if (frame !== null) window.cancelAnimationFrame(frame);
      setEditorHeight(nextHeight);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    editorResizeCleanupRef.current = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (frame !== null) window.cancelAnimationFrame(frame);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  };

  // Keyboard resize for the editor splitter: ArrowUp grows the editor (matching
  // a drag up), ArrowDown shrinks it, clamped the same way as the pointer drag.
  const onEditorResizeKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const panelHeight = sectionRef.current?.clientHeight ?? height;
    const maxHeight = Math.max(
      MIN_EDITOR_HEIGHT,
      panelHeight - EDITOR_RESIZE_RESERVE,
    );
    const delta = event.key === "ArrowUp" ? EDITOR_RESIZE_STEP : -EDITOR_RESIZE_STEP;
    setEditorHeight((h) =>
      Math.min(maxHeight, Math.max(MIN_EDITOR_HEIGHT, h + delta)),
    );
  };

  // On unmount, tear down any in-flight drag listeners (either axis).
  useEffect(
    () => () => {
      verticalResizeCleanupRef.current?.();
      editorResizeCleanupRef.current?.();
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
            variant={advancedMode ? "secondary" : "outline"}
            size="sm"
            className="h-8 gap-1.5"
            title={
              advancedMode
                ? t("pythonConsole.switchToBasic")
                : t("pythonConsole.switchToAdvanced")
            }
            aria-pressed={advancedMode}
            onClick={toggleAdvanced}
          >
            <Code2 className="h-4 w-4" />
            {t("pythonConsole.advancedLabel")}
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

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          ref={outputRef}
          className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-relaxed"
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

        {advancedMode ? (
          <>
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label={t("pythonConsole.resizeEditor")}
              aria-valuenow={editorHeight}
              aria-valuemin={MIN_EDITOR_HEIGHT}
              aria-valuemax={Math.max(
                MIN_EDITOR_HEIGHT,
                height - EDITOR_RESIZE_RESERVE,
              )}
              tabIndex={0}
              className="h-1 shrink-0 cursor-row-resize select-none bg-border hover:bg-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
              onMouseDown={startEditorResize}
              onKeyDown={onEditorResizeKeyDown}
            />
            <div
              ref={editorRegionRef}
              className="flex min-h-0 shrink-0 flex-col"
              // Clamp at render time so shrinking the outer panel can't let the
              // fixed-height editor crush the terminal; the stored editorHeight
              // is kept intact, so growing the panel back restores it.
              style={{
                height: Math.min(
                  editorHeight,
                  Math.max(MIN_EDITOR_HEIGHT, height - EDITOR_RESIZE_RESERVE),
                ),
              }}
            >
              <PythonEditorPane
                deps={deps}
                ready={ready}
                running={running}
                runScript={runScript}
                completionLabel={t("pythonConsole.completions")}
              />
            </div>
          </>
        ) : (
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
        )}
      </div>
    </section>
  );
}
