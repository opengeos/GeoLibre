import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "@geolibre/core";
import type { ProtomapsFlavor } from "@geolibre/map";
import { openLocalDataFileWithFallback } from "../lib/tauri-io";
import { OfflineBasemapRequests } from "../lib/offline-basemap-requests";
import {
  extractNativeMbtilesPackage,
  inspectNativeMbtilesSource,
  type NativeMbtilesAreaOptions,
  type NativeExtractionProgress,
} from "../lib/native-mbtiles-extraction";
import type { MbtilesMetadata } from "../lib/mbtiles-sqljs";

export interface NativeMbtilesSource {
  path: string;
  metadata: MbtilesMetadata;
}

/** Own native selection and extraction, sharing application ordering with the
 * panel's remote extracts, Open, and saved-package choices. */
export function useNativeMbtilesExtraction(open: boolean, requests: OfflineBasemapRequests) {
  const [source, setSource] = useState<NativeMbtilesSource | null>(null);
  const [phase, setPhase] = useState<"idle" | "inspect" | "extract">("idle");
  const [progress, setProgress] = useState<NativeExtractionProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const cancel = useCallback(() => {
    active.current?.abort();
    active.current = null;
    setPhase("idle");
    setProgress(null);
    setError(null);
  }, []);
  useEffect(() => {
    if (!open) cancel();
    return () => {
      active.current?.abort();
    };
  }, [open, cancel]);

  const begin = useCallback(
    (nextPhase: "inspect" | "extract") => {
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      const request = requests.begin();
      setPhase(nextPhase);
      setProgress(null);
      setError(null);
      let { projectLoadCount, basemapChoiceGeneration } = useAppStore.getState();
      const unsubscribe = useAppStore.subscribe((state) => {
        if (
          state.projectLoadCount === projectLoadCount &&
          state.basemapChoiceGeneration === basemapChoiceGeneration
        )
          return;
        ({ projectLoadCount, basemapChoiceGeneration } = state);
        // The deletion fallback may synchronously rebase an unrelated request.
        // Observe the completed store transition before deciding it is obsolete.
        queueMicrotask(() => {
          if (!request.isCurrent()) controller.abort();
        });
      });
      return {
        controller,
        request,
        report: (failure: unknown) => {
          if (active.current === controller && !controller.signal.aborted && request.isCurrent())
            setError(failure instanceof Error ? failure.message : String(failure));
        },
        finish: () => {
          unsubscribe();
          if (active.current === controller) {
            active.current = null;
            setPhase("idle");
          }
        },
      };
    },
    [requests],
  );

  const selectSource = useCallback(async () => {
    const operation = begin("inspect");
    try {
      const picked = await openLocalDataFileWithFallback({
        filters: [{ name: "MBTiles", extensions: ["mbtiles"] }],
        accept: ".mbtiles",
        readBinary: false,
      });
      if (!picked?.path || operation.controller.signal.aborted || !operation.request.isCurrent())
        return null;
      const metadata = await inspectNativeMbtilesSource(picked.path, operation.controller.signal);
      if (operation.controller.signal.aborted || !operation.request.isCurrent()) return null;
      const selected = { path: picked.path, metadata };
      setSource(selected);
      return selected;
    } catch (error) {
      operation.report(error);
      return null;
    } finally {
      operation.finish();
    }
  }, [begin]);

  const extract = useCallback(
    async (options: NativeMbtilesAreaOptions, flavor: ProtomapsFlavor | null) => {
      if (!source) return null;
      const operation = begin("extract");
      try {
        const result = await extractNativeMbtilesPackage(
          source.path,
          source.metadata.name,
          options,
          flavor,
          operation.controller.signal,
          (event) => {
            if (operation.request.isCurrent()) setProgress(event);
          },
        );
        // Return committed results even when obsolete, so the panel can refresh
        // global inventory independently from choosing a project's basemap.
        return { result, request: operation.request, signal: operation.controller.signal };
      } catch (error) {
        operation.report(error);
        return null;
      } finally {
        operation.finish();
      }
    },
    [begin, source],
  );

  return { source, phase, progress, error, busy: phase !== "idle", selectSource, extract, cancel };
}
