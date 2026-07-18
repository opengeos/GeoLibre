import { Dialog, DialogContent, DialogTitle } from "@geolibre/ui";
import { Search } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type Command, filterCommands, formatShortcut, isMacPlatform } from "../../lib/commands";

interface CommandPaletteProps {
  open: boolean;
  commands: Command[];
  onOpenChange: (open: boolean) => void;
}

/**
 * A searchable command palette (Cmd/Ctrl-K) built from the shared command
 * registry. Type to filter, navigate with arrow keys, and press Enter to run
 * the highlighted command.
 */
export function CommandPalette({ open, commands, onOpenChange }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const isMac = useMemo(() => isMacPlatform(), []);
  const listboxId = "command-palette-listbox";
  const optionId = (command: Command) => `command-option-${command.id}`;

  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);
  const activeCommand = filtered[activeIndex];

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

  // Scroll the highlighted row into view as the user navigates.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, filtered]);

  const runCommand = (command: Command) => {
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
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <div className="flex items-center gap-2 border-b px-3 pe-10">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            role="combobox"
            aria-label="Search commands"
            aria-expanded={true}
            aria-controls={listboxId}
            aria-activedescendant={activeCommand ? optionId(activeCommand) : undefined}
            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            placeholder="Search commands…"
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
          aria-label="Commands"
        >
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              No matching commands
            </p>
          ) : (
            filtered.map((command, index) => {
              const Icon = command.icon;
              const previousGroup = filtered[index - 1]?.group;
              const showGroup = command.group !== previousGroup;
              const isActive = index === activeIndex;
              return (
                <div key={command.id}>
                  {showGroup ? (
                    <div className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">
                      {command.group}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    id={optionId(command)}
                    role="option"
                    aria-selected={isActive}
                    data-active={isActive}
                    className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-start text-sm ${
                      isActive ? "bg-accent text-accent-foreground" : "text-foreground"
                    }`}
                    onMouseMove={() => setActiveIndex(index)}
                    onClick={() => runCommand(command)}
                  >
                    {Icon ? <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                    <span className="min-w-0 flex-1 truncate">{command.title}</span>
                    {command.shortcut ? (
                      <kbd className="shrink-0 rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {formatShortcut(command.shortcut, isMac)}
                      </kbd>
                    ) : null}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
