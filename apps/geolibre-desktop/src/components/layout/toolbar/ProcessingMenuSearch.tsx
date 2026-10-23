import { cn, DropdownMenuItem } from "@geolibre/ui";
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { filterCommands, type Command } from "../../../lib/commands";

const MAX_SEARCH_RESULTS = 100;

interface ProcessingMenuSearchProps {
  commands: Command[];
  open: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  onRun: (command: Command) => void;
  onDismiss: () => void;
}

/** Search and keyboard navigation shared by the Processing dropdown's tool catalog. */
export function ProcessingMenuSearch({
  commands,
  open,
  query,
  onQueryChange,
  onRun,
  onDismiss,
}: ProcessingMenuSearchProps) {
  const { t } = useTranslation();
  const [activeResult, setActiveResult] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const trimmedQuery = query.trim();
  const { searchResults, resultsTruncated } = useMemo(() => {
    const matches = trimmedQuery ? filterCommands(commands, trimmedQuery) : [];
    return {
      searchResults: matches.slice(0, MAX_SEARCH_RESULTS),
      resultsTruncated: matches.length > MAX_SEARCH_RESULTS,
    };
  }, [commands, trimmedQuery]);

  useEffect(() => {
    setActiveResult((index) =>
      searchResults.length === 0 ? 0 : Math.min(index, searchResults.length - 1),
    );
  }, [searchResults.length]);

  useEffect(() => {
    const activeOption = resultsRef.current?.querySelector<HTMLElement>(
      '[role="option"][aria-selected="true"]',
    );
    activeOption?.scrollIntoView?.({ block: "nearest" });
  }, [activeResult, searchResults]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return (
    <>
      <div className="flex items-center gap-2 px-2 pb-1">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          ref={searchRef}
          role="combobox"
          aria-label={t("processing.menuSearch.searchLabel")}
          aria-expanded={Boolean(trimmedQuery)}
          aria-controls={trimmedQuery ? "processing-menu-search-results" : undefined}
          aria-activedescendant={
            searchResults[activeResult]
              ? `processing-menu-search-result-${activeResult}`
              : undefined
          }
          className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          placeholder={t("processing.menuSearch.searchPlaceholder")}
          value={query}
          onChange={(event) => {
            onQueryChange(event.target.value);
            setActiveResult(0);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveResult((index) =>
                searchResults.length === 0 ? 0 : (index + 1) % searchResults.length,
              );
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveResult((index) =>
                searchResults.length === 0
                  ? 0
                  : (index - 1 + searchResults.length) % searchResults.length,
              );
            } else if (event.key === "Enter") {
              if (event.nativeEvent.isComposing) return;
              event.preventDefault();
              const command = searchResults[activeResult];
              if (command) onRun(command);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onDismiss();
            }
          }}
        />
      </div>
      {trimmedQuery && (
        <>
          <div
            ref={resultsRef}
            id="processing-menu-search-results"
            role="listbox"
            aria-label={t("processing.menuSearch.resultsLabel")}
            className="max-h-[min(60vh,24rem)] overflow-y-auto"
          >
            {searchResults.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {t("processing.menuSearch.noMatches")}
              </p>
            ) : (
              searchResults.map((command, index) => (
                <DropdownMenuItem
                  key={command.id}
                  id={`processing-menu-search-result-${index}`}
                  role="option"
                  aria-selected={index === activeResult}
                  className={cn(index === activeResult && "bg-accent text-accent-foreground")}
                  onPointerMove={(event) => {
                    event.preventDefault();
                    setActiveResult(index);
                  }}
                  onSelect={() => onRun(command)}
                >
                  <span className="min-w-0 flex-1 truncate">{command.title}</span>
                  <span className="ms-3 shrink-0 text-xs text-muted-foreground">
                    {command.group}
                  </span>
                </DropdownMenuItem>
              ))
            )}
          </div>
          {resultsTruncated ? (
            <p role="status" className="px-3 py-1.5 text-xs text-muted-foreground">
              {t("processing.menuSearch.resultsTruncated", { count: MAX_SEARCH_RESULTS })}
            </p>
          ) : null}
        </>
      )}
    </>
  );
}
