import { Dialog, DialogContent, DialogTitle } from "@geolibre/ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Search } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { type Command, filterCommands, formatShortcut, isMacPlatform } from "../../lib/commands";
import { groupRankedCommands, paletteRows } from "../../lib/palette-rows";

interface CommandPaletteProps {
  open: boolean;
  /** Commands listed with or without a query. */
  commands: Command[];
  /**
   * Commands matched only once the user types (the ~1,100 per-tool entries),
   * so the empty palette opens on the short list of actions.
   */
  searchOnlyCommands?: Command[];
  onOpenChange: (open: boolean) => void;
}

/** Estimated heights (px) before the virtualizer measures a row. */
const GROUP_ROW_HEIGHT = 28;
const COMMAND_ROW_HEIGHT = 32;

const NO_COMMANDS: Command[] = [];

/**
 * A searchable command palette (Cmd/Ctrl-K) built from the shared command
 * registry. Type to filter, navigate with arrow keys, and press Enter to run
 * the highlighted command.
 *
 * With the per-tool entries a broad query can match a thousand commands, so
 * the list is virtualized: only the rows in and around the viewport mount.
 */
export function CommandPalette({
  open,
  commands,
  searchOnlyCommands = NO_COMMANDS,
  onOpenChange,
}: CommandPaletteProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const isMac = useMemo(() => isMacPlatform(), []);
  const listboxId = "command-palette-listbox";
  const optionId = (command: Command) => `command-option-${command.id}`;

  const searchable = useMemo(
    () => (searchOnlyCommands.length ? [...commands, ...searchOnlyCommands] : commands),
    [commands, searchOnlyCommands],
  );
  const filtered = useMemo(
    () => (query.trim() ? groupRankedCommands(filterCommands(searchable, query)) : commands),
    [commands, searchable, query],
  );
  const activeCommand = filtered[activeIndex];
  const { rows, rowOfCommand } = useMemo(() => paletteRows(filtered), [filtered]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => (rows[index].kind === "group" ? GROUP_ROW_HEIGHT : COMMAND_ROW_HEIGHT),
    getItemKey: (index) => {
      const row = rows[index];
      return row.kind === "group" ? `group:${row.index}` : row.command.id;
    },
    overscan: 8,
    // Mount the first rows on the first render, before the list has been
    // measured, so the palette never opens empty.
    initialRect: { width: 0, height: 384 },
  });
  const virtualItems = virtualizer.getVirtualItems();
  // aria-activedescendant must name an element in the DOM; with virtualization
  // the active row may not be mounted (e.g. mid-scroll), so point at it only
  // when it is.
  const activeRow = rowOfCommand[activeIndex];
  const activeMounted =
    activeRow !== undefined && virtualItems.some((item) => item.index === activeRow);

  // Reset the query each time the palette opens so it always starts fresh.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
    }
  }, [open]);

  // Keep the highlight within bounds as the filtered list shrinks/grows.
  useEffect(() => {
    setActiveIndex((index) => (filtered.length === 0 ? 0 : Math.min(index, filtered.length - 1)));
  }, [filtered.length]);

  // Scroll the highlighted row into view as the user navigates. The row may not
  // be mounted (virtualized), so scroll by index rather than by element. The
  // first command also brings its group header into view.
  useEffect(() => {
    const row = rowOfCommand[activeIndex];
    if (row === undefined) return;
    virtualizer.scrollToIndex(activeIndex === 0 ? 0 : row, { align: "auto" });
  }, [activeIndex, rowOfCommand, virtualizer]);

  const runCommand = (command: Command) => {
    if (command.disabledReason) return;
    onOpenChange(false);
    command.run();
  };

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (filtered.length === 0 ? 0 : (index + 1) % filtered.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) =>
        filtered.length === 0 ? 0 : (index - 1 + filtered.length) % filtered.length,
      );
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(Math.max(0, filtered.length - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const command = filtered[activeIndex];
      if (command) runCommand(command);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        bodyClassName="p-0 gap-0"
        className="top-[15%] max-w-xl translate-y-0"
      >
        <DialogTitle className="sr-only">{t("commandPalette.title")}</DialogTitle>
        <div className="flex items-center gap-2 border-b px-3 pe-10">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            role="combobox"
            aria-label={t("commandPalette.searchAria")}
            aria-expanded={true}
            aria-controls={listboxId}
            aria-activedescendant={
              activeCommand && activeMounted ? optionId(activeCommand) : undefined
            }
            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            placeholder={t("commandPalette.searchPlaceholder")}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleInputKeyDown}
          />
        </div>
        <div
          ref={listRef}
          id={listboxId}
          className="max-h-[min(60vh,24rem)] overflow-y-auto p-1"
          role="listbox"
          aria-label={t("commandPalette.listAria")}
        >
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {t("commandPalette.noMatches")}
            </p>
          ) : (
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualItems.map((item) => {
                const row = rows[item.index];
                return (
                  <div
                    key={item.key}
                    ref={virtualizer.measureElement}
                    data-index={item.index}
                    className="absolute start-0 top-0 w-full"
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    {row.kind === "group" ? (
                      <div className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">
                        {row.label}
                      </div>
                    ) : (
                      <CommandRow
                        command={row.command}
                        id={optionId(row.command)}
                        active={row.index === activeIndex}
                        isMac={isMac}
                        onHover={() => setActiveIndex(row.index)}
                        onRun={() => runCommand(row.command)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface CommandRowProps {
  command: Command;
  id: string;
  active: boolean;
  isMac: boolean;
  onHover: () => void;
  onRun: () => void;
}

/** One selectable palette option. */
function CommandRow({ command, id, active, isMac, onHover, onRun }: CommandRowProps) {
  const Icon = command.icon;
  return (
    <button
      type="button"
      id={id}
      role="option"
      aria-selected={active}
      aria-disabled={Boolean(command.disabledReason)}
      data-active={active}
      className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-start text-sm ${
        active ? "bg-accent text-accent-foreground" : "text-foreground"
      } ${command.disabledReason ? "opacity-50" : ""}`}
      onMouseMove={onHover}
      onClick={onRun}
    >
      {Icon ? <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
      <span className="min-w-0 flex-1 truncate">{command.title}</span>
      {command.disabledReason ? (
        <span className="text-xs text-muted-foreground">{command.disabledReason}</span>
      ) : null}
      {command.shortcut ? (
        <kbd className="shrink-0 rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {formatShortcut(command.shortcut, isMac)}
        </kbd>
      ) : null}
    </button>
  );
}
