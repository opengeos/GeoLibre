import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  sqlCompletionCandidates,
  wordPrefixAt,
} from "./sql-completion";
import type { SqlWorkspaceTableColumns } from "./sql-workspace";

interface CompletionState {
  open: boolean;
  prefix: string;
  candidates: string[];
  index: number;
  start: number;
}

interface UseSqlCompletionOptions {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  sql: string;
  setSql: (value: string) => void;
  /** Loaded layers exposed as tables, with their columns. */
  tables: SqlWorkspaceTableColumns[];
  /** Accessible label for the candidate listbox. */
  label: string;
}

export interface SqlCompletion {
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
 * Schema-aware SQL autocomplete for a textarea. Unlike the Python console's
 * runtime-introspecting completion, candidates are derived synchronously from a
 * static keyword/function list plus the loaded layers' table and column names,
 * so it works without any backend. Tab (when the dropdown is closed) or
 * Ctrl+Space requests completions; Tab/Enter accept, arrows navigate, Escape
 * closes.
 *
 * @param options - The target textarea ref, its controlled `sql`/`setSql`, the
 *   queryable tables with columns, and the listbox label.
 * @returns Key handling, the dropdown node, open state, and a close function.
 */
export function useSqlCompletion({
  textareaRef,
  sql,
  setSql,
  tables,
  label,
}: UseSqlCompletionOptions): SqlCompletion {
  const [completion, setCompletion] = useState<CompletionState>({
    open: false,
    prefix: "",
    candidates: [],
    index: 0,
    start: 0,
  });
  // Caret offset to apply after the next accepted completion updates `sql`.
  const pendingCaretRef = useRef<number | null>(null);

  useEffect(() => {
    if (pendingCaretRef.current === null) return;
    const pos = pendingCaretRef.current;
    pendingCaretRef.current = null;
    const ta = textareaRef.current;
    if (ta) ta.setSelectionRange(pos, pos);
  }, [sql, textareaRef]);

  const close = () =>
    setCompletion((c) => (c.open ? { ...c, open: false } : c));

  const applyCompletion = (candidate: string, start: number, end: number) => {
    // Clamp against the current `sql` in case it changed since the candidates
    // were computed, so the splice offsets can't land out of range.
    const safeEnd = Math.min(Math.max(0, end), sql.length);
    const safeStart = Math.min(Math.max(0, start), safeEnd);
    pendingCaretRef.current = safeStart + candidate.length;
    setSql(sql.slice(0, safeStart) + candidate + sql.slice(safeEnd));
    close();
  };

  const trigger = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    const cursor = ta.selectionStart ?? sql.length;
    const { prefix, start } = wordPrefixAt(sql, cursor);
    const candidates = sqlCompletionCandidates(prefix, tables);
    if (candidates.length === 0) {
      close();
    } else if (candidates.length === 1) {
      applyCompletion(candidates[0], start, cursor);
    } else {
      setCompletion({ open: true, prefix, candidates, index: 0, start });
    }
  };

  const tryKey = (
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
  ): boolean => {
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
      // Plain Enter or Tab accepts the highlighted candidate. Ctrl/Cmd+Enter is
      // left to the host so it always runs the query, even with the dropdown
      // open (the dropdown closes when the query starts).
      if (
        (event.key === "Enter" && !event.ctrlKey && !event.metaKey) ||
        event.key === "Tab"
      ) {
        event.preventDefault();
        const ta = textareaRef.current;
        const cursor = ta?.selectionStart ?? completion.start;
        applyCompletion(
          completion.candidates[completion.index],
          completion.start,
          cursor,
        );
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return true;
      }
    }
    if (event.key === " " && event.ctrlKey) {
      event.preventDefault();
      trigger();
      return true;
    }
    if (event.key === "Tab") {
      // Only intercept Tab when there is something to complete; otherwise let it
      // move focus so the editor is not a keyboard trap (WCAG 2.1.2).
      const ta = textareaRef.current;
      const cursor = ta?.selectionStart ?? sql.length;
      const { prefix } = wordPrefixAt(sql, cursor);
      if (sqlCompletionCandidates(prefix, tables).length === 0) return false;
      event.preventDefault();
      trigger();
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
          className={`block w-full px-3 py-1 text-left font-mono text-xs ${
            i === completion.index
              ? "bg-accent text-accent-foreground"
              : "hover:bg-accent/50"
          }`}
          // Keep focus in the textarea so the caret update applies.
          onMouseDown={(event) => {
            event.preventDefault();
            const ta = textareaRef.current;
            const cursor = ta?.selectionStart ?? completion.start;
            applyCompletion(candidate, completion.start, cursor);
          }}
        >
          {candidate}
        </button>
      ))}
    </div>
  ) : null;

  return { tryKey, dropdown, isOpen: completion.open, close };
}
