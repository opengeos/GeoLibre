import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { completeConsoleCode } from "./pyodide-console";
import type { ScriptingDeps } from "../scripting/scriptingApi";

interface CompletionState {
  open: boolean;
  prefix: string;
  candidates: string[];
  index: number;
  cursor: number;
}

interface UsePyCompletionOptions {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  code: string;
  setCode: (value: string) => void;
  deps: ScriptingDeps;
  ready: boolean;
  /** Accessible label for the candidate listbox. */
  label: string;
  /**
   * Whether Tab (with the dropdown closed) requests completions. True for the
   * console input; false for the editor, where Tab indents and Ctrl+Space
   * requests completions instead. Tab always accepts when the dropdown is open.
   * Defaults to true.
   */
  tabTriggers?: boolean;
}

export interface PyCompletion {
  /**
   * Handle a key event for completion (dropdown navigation, Tab/Ctrl+Space to
   * trigger). Returns true when it consumed the event, so a host `onKeyDown`
   * can early-return.
   */
  tryKey: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** The candidate dropdown to render inside the input container (or null). */
  dropdown: ReactNode;
  /** Whether the dropdown is open. */
  isOpen: boolean;
  /** Close the dropdown (e.g. when the host's text changes or runs). */
  close: () => void;
}

/**
 * Namespace-aware Python autocomplete for a textarea, shared by the console
 * input and the script editor. Introspects the live Pyodide runtime via
 * {@link completeConsoleCode}, so `obj.` lists real attributes.
 *
 * @param options - The target textarea ref, its controlled `code`/`setCode`, the
 *   runtime deps, whether the runtime is ready, and the listbox label.
 * @returns Key handling, the dropdown node, open state, and a close function.
 */
export function usePyCompletion({
  textareaRef,
  code,
  setCode,
  deps,
  ready,
  label,
  tabTriggers = true,
}: UsePyCompletionOptions): PyCompletion {
  const [completion, setCompletion] = useState<CompletionState>({
    open: false,
    prefix: "",
    candidates: [],
    index: 0,
    cursor: 0,
  });
  // Caret offset to apply after the next accepted completion updates `code`.
  const pendingCaretRef = useRef<number | null>(null);

  useEffect(() => {
    if (pendingCaretRef.current === null) return;
    const pos = pendingCaretRef.current;
    pendingCaretRef.current = null;
    const ta = textareaRef.current;
    if (ta) ta.setSelectionRange(pos, pos);
  }, [code, textareaRef]);

  const close = () => setCompletion((c) => (c.open ? { ...c, open: false } : c));

  const applyCompletion = (candidate: string, prefix: string, cursor: number) => {
    // Clamp against the current `code` in case it changed since the candidates
    // were computed, so the splice offsets can't land out of range.
    const safeCursor = Math.min(Math.max(0, cursor), code.length);
    const start = Math.max(0, safeCursor - prefix.length);
    pendingCaretRef.current = start + candidate.length;
    setCode(code.slice(0, start) + candidate + code.slice(safeCursor));
    close();
  };

  const trigger = async () => {
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
      close();
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

  const tryKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (completion.open) {
      const n = completion.candidates.length;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setCompletion((c) => ({ ...c, index: (c.index + 1) % n }));
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setCompletion((c) => ({ ...c, index: (c.index - 1 + n) % n }));
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        applyCompletion(
          completion.candidates[completion.index],
          completion.prefix,
          completion.cursor,
        );
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return true;
      }
    }
    if ((tabTriggers && event.key === "Tab") || (event.key === " " && event.ctrlKey)) {
      event.preventDefault();
      void trigger();
      return true;
    }
    return false;
  };

  const dropdown = completion.open ? (
    <div
      role="listbox"
      aria-label={label}
      className="absolute bottom-full left-3 z-30 mb-1 max-h-48 w-72 overflow-auto rounded-md border bg-popover py-1 text-popover-foreground shadow-md"
    >
      {completion.candidates.map((candidate, i) => (
        <button
          type="button"
          key={candidate}
          role="option"
          aria-selected={i === completion.index}
          className={`block w-full px-3 py-1 text-start font-mono text-xs ${
            i === completion.index ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
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
  ) : null;

  return { tryKey, dropdown, isOpen: completion.open, close };
}
