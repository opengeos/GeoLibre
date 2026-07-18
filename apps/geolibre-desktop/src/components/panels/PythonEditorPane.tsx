import { Button, Textarea } from "@geolibre/ui";
import { Eraser, FilePlus, FolderOpen, Loader2, Play, Save, SaveAll } from "lucide-react";
import {
  type ChangeEvent as ReactChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { ScriptingDeps } from "../../lib/scripting/scriptingApi";
import { usePyCompletion } from "../../lib/pyodide/usePyCompletion";
import { isTauri } from "../../lib/is-tauri";
import {
  openLocalDataFileWithFallback,
  saveTextFileWithFallback,
  writeTextFileToPath,
} from "../../lib/tauri-io";

interface PythonEditorPaneProps {
  deps: ScriptingDeps;
  ready: boolean;
  running: boolean;
  /** Run a script in the shared console runtime; `label` names it in the output. */
  runScript: (source: string, label: string) => void;
  completionLabel: string;
}

const PY_FILTERS = [{ name: "Python", extensions: ["py"] }];

function basename(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

/**
 * A QGIS-style script editor that lives beside the Python Console and shares its
 * interpreter. Open/Save/Save As `.py` files (via the app's cross-platform file
 * I/O), and Run the whole buffer or the current selection — output goes to the
 * console scrollback.
 */
export function PythonEditorPane({
  deps,
  ready,
  running,
  runScript,
  completionLabel,
}: PythonEditorPaneProps) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Selection [start, end] to restore after a programmatic `code` change.
  const caretRef = useRef<[number, number] | null>(null);
  const [code, setCode] = useState("");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const completion = usePyCompletion({
    textareaRef,
    code,
    setCode,
    deps,
    ready,
    label: completionLabel,
    // In the editor Tab indents; Ctrl+Space requests completions.
    tabTriggers: false,
  });

  // Apply a queued selection after a programmatic `code` change (indent insert).
  useEffect(() => {
    if (caretRef.current === null) return;
    const [start, end] = caretRef.current;
    caretRef.current = null;
    const ta = textareaRef.current;
    if (ta) ta.setSelectionRange(start, end);
  }, [code]);

  const onChange = (event: ReactChangeEvent<HTMLTextAreaElement>) => {
    setCode(event.target.value);
    setDirty(true);
    completion.close();
  };

  const insertIndent = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    const indent = "    "; // 4 spaces (PEP 8)
    const start = ta.selectionStart ?? code.length;
    const end = ta.selectionEnd ?? start;
    if (start === end) {
      caretRef.current = [start + indent.length, start + indent.length];
      setCode(code.slice(0, start) + indent + code.slice(end));
      setDirty(true);
      return;
    }
    // Block-indent every line touched by the selection (don't delete it).
    const lineStart = code.lastIndexOf("\n", start - 1) + 1;
    const block = code.slice(lineStart, end);
    const indented = block.replace(/^/gm, indent);
    const added = indented.length - block.length;
    caretRef.current = [start + indent.length, end + added];
    setCode(code.slice(0, lineStart) + indented + code.slice(end));
    setDirty(true);
  };

  const runEditor = () => {
    const ta = textareaRef.current;
    const hasSelection = !!ta && ta.selectionStart !== ta.selectionEnd;
    const source = hasSelection && ta ? code.slice(ta.selectionStart, ta.selectionEnd) : code;
    if (!source.trim()) return;
    const name = filePath ? basename(filePath) : t("pythonConsole.untitled");
    runScript(source, hasSelection ? `${name} (selection)` : name);
  };

  const openScript = async () => {
    if (dirty && !window.confirm(t("pythonConsole.discardChanges"))) return;
    const result = await openLocalDataFileWithFallback({
      filters: PY_FILTERS,
      accept: ".py",
      readText: true,
    });
    if (result && result.text !== undefined) {
      setCode(result.text);
      setFilePath(result.path);
      setDirty(false);
    }
  };

  const saveScriptAs = async () => {
    const path = await saveTextFileWithFallback(code, {
      defaultName: filePath ? basename(filePath) : "script.py",
      filters: PY_FILTERS,
      browserTypes: [{ description: "Python", accept: { "text/x-python": [".py"] } }],
      mimeType: "text/x-python",
    });
    if (path) {
      setFilePath(path);
      setDirty(false);
    }
  };

  const saveScript = async () => {
    // Desktop with a known path: write in place. Otherwise prompt (web has no
    // writable filesystem path).
    if (filePath && isTauri()) {
      await writeTextFileToPath(filePath, code);
      setDirty(false);
      return;
    }
    await saveScriptAs();
  };

  const newScript = () => {
    if (dirty && !window.confirm(t("pythonConsole.discardChanges"))) return;
    setCode("");
    setFilePath(null);
    setDirty(false);
  };

  const clearEditor = () => {
    if (!code) return;
    if (dirty && !window.confirm(t("pythonConsole.discardChanges"))) return;
    setCode("");
    // Keep the current filename; the emptied buffer now differs from the file.
    setDirty(filePath !== null);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (completion.tryKey(event)) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      runEditor();
      return;
    }
    if ((event.key === "s" || event.key === "S") && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void saveScript();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      insertIndent();
    }
  };

  const name = filePath ? basename(filePath) : t("pythonConsole.untitled");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-0.5 border-b px-2 py-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title={t("pythonConsole.fileNew")}
          onClick={newScript}
        >
          <FilePlus className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title={t("pythonConsole.fileOpen")}
          onClick={() => void openScript()}
        >
          <FolderOpen className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title={t("pythonConsole.fileSave")}
          onClick={() => void saveScript()}
        >
          <Save className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title={t("pythonConsole.fileSaveAs")}
          onClick={() => void saveScriptAs()}
        >
          <SaveAll className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title={t("pythonConsole.clearEditor")}
          onClick={clearEditor}
        >
          <Eraser className="h-4 w-4" />
        </Button>
        <span
          className="ms-1 min-w-0 flex-1 truncate text-xs text-muted-foreground"
          title={filePath ?? name}
        >
          {name}
          {dirty ? " •" : ""}
        </span>
        <Button
          size="sm"
          className="ms-auto h-7"
          onClick={runEditor}
          disabled={running || !ready || !code.trim()}
          title={t("pythonConsole.runScript")}
        >
          {running ? (
            <Loader2 className="me-1 h-4 w-4 animate-spin" />
          ) : (
            <Play className="me-1 h-4 w-4" />
          )}
          {t("pythonConsole.run")}
        </Button>
      </div>

      <Textarea
        ref={textareaRef}
        value={code}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder={t("pythonConsole.editorPlaceholder")}
        spellCheck={false}
        className="min-h-0 flex-1 resize-none rounded-none border-0 font-mono text-xs focus-visible:ring-0"
      />
      {/* Anchors the completion dropdown just above the editor's bottom edge. */}
      <div className="relative">{completion.dropdown}</div>
    </div>
  );
}
