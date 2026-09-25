import { Button, Input, cn } from "@geolibre/ui";
import { ChevronDown, RefreshCw, Search } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { classifyFetchFailure } from "../lib/fetch-error";
import {
  type DiscoveredModel,
  type KeyedDiscoveryProvider,
  discoverProviderModels,
} from "../lib/assistant/model-discovery";
import { discoverOpenRouterModels } from "../lib/assistant/openrouter";
import { PROVIDER_LABELS, PROVIDER_MODELS } from "../lib/assistant/provider";

/** Wait this long after the API key last changed before discovering, so typing a key does not fire a request per keystroke. */
const KEY_SETTLE_MS = 500;

export interface ProviderModelPickerProps {
  /** The provider whose live catalog to list. */
  provider: "openrouter" | KeyedDiscoveryProvider;
  /** The provider API key; required for discovery except on OpenRouter's public catalog. */
  apiKey?: string | null;
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  compact?: boolean;
}

/**
 * Searchable model picker backed by the provider's live catalog, with refresh
 * and manual model-ID entry. Until discovery succeeds (no key yet, offline, a
 * rejected key) it lists the built-in presets from {@link PROVIDER_MODELS}.
 * Failed discovery never changes {@link ProviderModelPickerProps.value}.
 */
export function ProviderModelPicker({
  provider,
  apiKey,
  value,
  onChange,
  disabled = false,
  compact = false,
}: ProviderModelPickerProps): ReactElement {
  const { t } = useTranslation();
  const listId = `${useId()}-${provider}-models`;
  const key = apiKey?.trim() ?? "";
  const canDiscover = provider === "openrouter" || key.length > 0;
  // Tagged with the inputs that produced it, so a catalog loaded for one
  // provider or key is never shown under another while the next one loads.
  const [discovered, setDiscovered] = useState<{
    provider: string;
    key: string;
    models: DiscoveredModel[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [manualModelId, setManualModelId] = useState(value);
  const requestGeneration = useRef(0);
  const inFlight = useRef<AbortController | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  /** Load the live catalog, ignoring stale results after a newer refresh or unmount. */
  const refresh = useCallback(
    async (force = false) => {
      const generation = ++requestGeneration.current;
      inFlight.current?.abort();
      setError(null);
      if (!canDiscover) {
        inFlight.current = null;
        setDiscovered(null);
        setLoading(false);
        return;
      }
      const controller = new AbortController();
      inFlight.current = controller;
      setLoading(true);
      try {
        const models =
          provider === "openrouter"
            ? await discoverOpenRouterModels(controller.signal)
            : await discoverProviderModels(provider, key, { signal: controller.signal, force });
        if (generation !== requestGeneration.current) return;
        setDiscovered({ provider, key, models });
      } catch (cause) {
        if (generation !== requestGeneration.current || controller.signal.aborted) return;
        const failure = classifyFetchFailure(cause);
        const message =
          failure.kind === "network" || failure.kind === "timeout"
            ? (failure.hint ?? (cause instanceof Error ? cause.message : String(cause)))
            : cause instanceof Error
              ? cause.message
              : String(cause);
        setDiscovered(null);
        setError(t("settings.ai.modelsFailedToLoad", { message }));
        console.error(`[GeoLibre] Could not load ${PROVIDER_LABELS[provider]} models`, cause);
      } finally {
        if (generation === requestGeneration.current) setLoading(false);
      }
    },
    [canDiscover, key, provider, t],
  );

  useEffect(() => {
    const timer = setTimeout(() => void refresh(), provider === "openrouter" ? 0 : KEY_SETTLE_MS);
    return () => {
      clearTimeout(timer);
      requestGeneration.current += 1;
      inFlight.current?.abort();
    };
  }, [provider, refresh]);

  useEffect(() => setManualModelId(value), [value]);

  const catalogModels = useMemo(() => {
    const current =
      discovered?.provider === provider && discovered.key === key ? discovered.models : [];
    const models =
      current.length > 0 ? current : PROVIDER_MODELS[provider].map((id) => ({ id, name: id }));
    if (!value || models.some((model) => model.id === value)) return models;
    return [...models, { id: value, name: value }];
  }, [discovered, key, provider, value]);
  const matchingModels = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return catalogModels;
    return catalogModels.filter(
      (model) =>
        model.id.toLowerCase().includes(normalized) ||
        model.name.toLowerCase().includes(normalized),
    );
  }, [catalogModels, query]);
  const selectedName = catalogModels.find((model) => model.id === value)?.name ?? value;

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(matchingModels.length - 1, 0)));
  }, [matchingModels.length]);

  /** Close the popup, optionally restoring focus to the trigger. */
  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);
  useEffect(() => {
    if (disabled) close();
  }, [close, disabled]);

  useEffect(() => {
    if (!open) return;
    /** Close the popup on pointer-down outside the picker container. */
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [close, open]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    panelRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [open]);

  useEffect(() => {
    if (!open || matchingModels.length === 0) return;
    document
      .getElementById(`${listId}-option-${activeIndex}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, listId, matchingModels.length, open]);

  /** Apply a catalog model and close the popup, restoring focus. */
  const choose = (model: DiscoveredModel) => {
    if (disabled) return;
    onChange(model.id);
    close(true);
  };

  /** Toggle the popup, resetting the search query and reselecting the current model. */
  const showPicker = () => {
    if (open) {
      close(true);
      return;
    }
    setQuery("");
    const selectedIndex = catalogModels.findIndex((model) => model.id === value);
    setActiveIndex(Math.max(selectedIndex, 0));
    setOpen(true);
  };

  /** Apply the trimmed manual model ID (no-op when blank) and close the popup. */
  const applyManualModelId = () => {
    const id = manualModelId.trim();
    if (disabled || !id) return;
    onChange(id);
    close(true);
  };

  return (
    <div
      ref={containerRef}
      className="relative min-w-0"
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        // A null target means a WebKit mouse click on a non-focusable button or
        // window deactivation; the pointerdown listener handles outside clicks.
        if (open && next && !containerRef.current?.contains(next)) close();
      }}
    >
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        disabled={disabled}
        aria-label={t("assistant.model")}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn("w-full justify-between gap-2", compact && "h-8 max-w-[180px] text-xs")}
        onClick={showPicker}
      >
        <span className="truncate">{selectedName || t("assistant.model")}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      </Button>

      {open ? (
        <div
          ref={panelRef}
          // Focusable so a click on a non-focusable part of the popup (the
          // listbox scrollbar, padding, status text) keeps focus inside the
          // picker. Otherwise focus moves to the nearest focusable ancestor,
          // such as the Settings dialog, and the blur handler closes the popup.
          tabIndex={-1}
          className={cn(
            "absolute top-full z-40 mt-1 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md outline-none",
            compact ? "end-0" : "start-0",
          )}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close(true);
            }
          }}
        >
          <div className="flex items-center gap-1 border-b p-1.5">
            <div className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute start-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                ref={searchRef}
                type="text"
                role="combobox"
                aria-expanded
                aria-controls={matchingModels.length > 0 ? listId : undefined}
                aria-activedescendant={
                  matchingModels.length > 0 ? `${listId}-option-${activeIndex}` : undefined
                }
                aria-label={t("settings.ai.searchModels")}
                placeholder={t("settings.ai.searchModels")}
                className="h-8 ps-7 text-xs"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setActiveIndex((index) =>
                      Math.min(index + 1, Math.max(matchingModels.length - 1, 0)),
                    );
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setActiveIndex((index) => Math.max(index - 1, 0));
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    const model = matchingModels[activeIndex];
                    if (model) choose(model);
                  }
                }}
              />
            </div>
            <Button
              type="button"
              size={error ? "sm" : "icon"}
              variant="ghost"
              disabled={loading || !canDiscover}
              aria-label={t("settings.ai.refreshModels")}
              title={t("settings.ai.refreshModels")}
              onClick={() => void refresh(true)}
            >
              {error ? (
                t("settings.ai.refreshModels")
              ) : (
                <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              )}
            </Button>
          </div>

          {loading ? (
            <p role="status" className="px-2 py-2 text-xs text-muted-foreground">
              {t("settings.ai.modelsLoading")}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="px-2 py-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
          {matchingModels.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">{t("settings.ai.noModels")}</p>
          ) : (
            <div
              id={listId}
              role="listbox"
              aria-busy={loading}
              className="max-h-64 overflow-y-auto py-1"
            >
              {matchingModels.map((model, index) => (
                <button
                  key={model.id}
                  id={`${listId}-option-${index}`}
                  type="button"
                  role="option"
                  aria-selected={model.id === value}
                  tabIndex={-1}
                  className={cn(
                    "flex w-full items-baseline justify-between gap-2 px-2 py-1 text-start text-xs hover:bg-accent",
                    index === activeIndex && "bg-accent",
                  )}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(model)}
                  onFocus={() => setActiveIndex(index)}
                >
                  <span className="min-w-0 truncate">{model.name}</span>
                  {model.name !== model.id ? (
                    <span className="shrink-0 text-muted-foreground">{model.id}</span>
                  ) : null}
                </button>
              ))}
            </div>
          )}

          <div className="space-y-1.5 border-t p-2">
            <label htmlFor={`${listId}-manual`} className="text-xs font-medium">
              {t("settings.ai.manualModelId")}
            </label>
            <div className="flex items-center gap-2">
              <Input
                id={`${listId}-manual`}
                value={manualModelId}
                onChange={(event) => setManualModelId(event.target.value)}
                className="h-8 min-w-0 text-xs"
              />
              <Button
                type="button"
                size="sm"
                disabled={!manualModelId.trim()}
                onClick={applyManualModelId}
              >
                {t("settings.ai.applyModelId")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
