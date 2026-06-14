import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { Button, Textarea } from "@geolibre/ui";
import { Eraser, Loader2, Play, Terminal, X } from "lucide-react";
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
  completeConsoleCode,
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Tears down an in-flight drag's window listeners; set while dragging so an
  // unmount mid-drag (e.g. closing the panel) doesn't leak them.
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  // Caret offset to apply after the next controlled `code` update (so a
  // history recall or accepted completion lands the cursor sensibly).
  const pendingCaretRef = useRef<number | null>(null);
  // Submitted commands (newest last) for up/down recall, plus the cursor into
  // them and the draft saved when history navigation begins.
  const commandHistoryRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number | null>(null);
  const historyDraftRef = useRef("");
  const [height, setHeight] = useState(DEFAULT_CONSOLE_HEIGHT);
  const [code, setCode] = useState("");
  const [history, setHistory] = useState<Entry[]>([]);
  const [running, setRunning] = useState(false);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [completion, setCompletion] = useState<{
    open: boolean;
    prefix: string;
    candidates: string[];
    index: number;
    cursor: number;
  }>({ open: false, prefix: "", candidates: [], index: 0, cursor: 0 });

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

  const closeCompletion = () =>
    setCompletion((c) => (c.open ? { ...c, open: false } : c));

  const run = async () => {
    const source = code.trim();
    if (!source || running) return;
    // Record for up/down recall (skip a consecutive duplicate), reset the cursor.
    const cmds = commandHistoryRef.current;
    if (cmds[cmds.length - 1] !== source) cmds.push(source);
    historyIndexRef.current = null;
    closeCompletion();
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

  // Apply a queued caret position after a programmatic `code` change.
  useEffect(() => {
    if (pendingCaretRef.current === null) return;
    const pos = pendingCaretRef.current;
    pendingCaretRef.current = null;
    const ta = textareaRef.current;
    if (ta) ta.setSelectionRange(pos, pos);
  }, [code]);

  const applyCompletion = (candidate: string, prefix: string, cursor: number) => {
    const start = cursor - prefix.length;
    pendingCaretRef.current = start + candidate.length;
    setCode(code.slice(0, start) + candidate + code.slice(cursor));
    closeCompletion();
  };

  const triggerCompletion = async () => {
    const ta = textareaRef.current;
    if (!ta || !ready) return;
    const cursor = ta.selectionStart ?? code.length;
    let result;
    try {
      result = await completeConsoleCode(deps, code, cursor);
    } catch {
      return;
    }
    if (result.candidates.length === 0) {
      closeCompletion();
    } else if (result.candidates.length === 1) {
      applyCompletion(result.candidates[0], result.prefix, cursor);
    } else {
      setCompletion({
        open: true,
        prefix: result.prefix,
        candidates: result.candidates,
        index: 0,
        cursor,
      });
    }
  };

  // Recall a previous command. dir -1 = older, +1 = newer. Only navigates when
  // the caret is on the first line (older) or last line (newer), so multi-line
  // editing's arrow keys still move between lines. Returns true when handled.
  const navigateHistory = (dir: -1 | 1): boolean => {
    const ta = textareaRef.current;
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
    pendingCaretRef.current = text.length;
    setCode(text);
    return true;
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // When the completion list is open, arrows/Enter/Tab/Esc drive it.
    if (completion.open) {
      const n = completion.candidates.length;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setCompletion((c) => ({ ...c, index: (c.index + 1) % n }));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setCompletion((c) => ({ ...c, index: (c.index - 1 + n) % n }));
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        applyCompletion(
          completion.candidates[completion.index],
          completion.prefix,
          completion.cursor,
        );
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeCompletion();
        return;
      }
    }
    // Tab or Ctrl+Space requests completions.
    if (event.key === "Tab" || (event.key === " " && event.ctrlKey)) {
      event.preventDefault();
      void triggerCompletion();
      return;
    }
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

  const onChange = (event: ReactChangeEvent<HTMLTextAreaElement>) => {
    setCode(event.target.value);
    // The user is typing their own line again — leave history recall.
    historyIndexRef.current = null;
    closeCompletion();
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

      <div className="relative flex items-end gap-2 border-t px-3 py-2">
        {completion.open ? (
          <div
            role="listbox"
            aria-label={t("pythonConsole.completions")}
            className="absolute bottom-full left-3 z-30 mb-1 max-h-48 w-72 overflow-auto rounded-md border bg-popover py-1 text-popover-foreground shadow-md"
          >
            {completion.candidates.map((candidate, i) => (
              <button
                type="button"
                key={candidate}
                role="option"
                aria-selected={i === completion.index}
                className={`block w-full px-3 py-1 text-left font-mono text-xs ${
                  i === completion.index
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/50"
                }`}
                // Keep focus in the textarea so the caret update applies.
                onMouseDown={(event) => {
                  event.preventDefault();
                  applyCompletion(candidate, completion.prefix, completion.cursor);
                }}
              >
                {candidate}
              </button>
            ))}
          </div>
        ) : null}
        <Textarea
          ref={textareaRef}
          value={code}
          onChange={onChange}
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
