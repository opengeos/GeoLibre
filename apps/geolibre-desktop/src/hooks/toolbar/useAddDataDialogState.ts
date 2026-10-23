import { useAppStore } from "@geolibre/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AddDataKind } from "../../components/layout/AddDataDialog";
import {
  OPEN_ADD_DATA_EVENT,
  type OpenAddDataDetail,
  type OpenAddDataPostgres,
  type OpenAddDataMssql,
} from "../../components/layout/add-data/open-add-data";
import { serviceUrlParameter, type ServiceUrlParameter } from "../../lib/data-url";
import { masHidesDataSource } from "../../lib/mas-build";

/** The Add Data dialog's props that this hook owns (all but the map ref). */
export interface AddDataDialogStateProps {
  kind: AddDataKind | null;
  initialDeckVizKind: string | undefined;
  initialPostgres: OpenAddDataPostgres | undefined;
  initialMssql: OpenAddDataMssql | undefined;
  initialUrl: string | undefined;
  initialLayer: string | undefined;
  initialStyleUrl: string | undefined;
  initialKeyword: string | undefined;
  targetGroupId: string | null;
  onOpenChange: (open: boolean) => void;
}

export interface AddDataDialogState {
  /** Opens the dialog on `kind`, ungrouped (drops any earlier group target). */
  openAddDataKind: (kind: AddDataKind) => void;
  /** Picks the deck.gl layer type the dialog opens on (e.g. the 3D-model entry). */
  setAddDataDeckVizKind: (kind: string | undefined) => void;
  /** Spread onto `<AddDataDialog>`. */
  dialogProps: AddDataDialogStateProps;
}

/**
 * Owns the Add Data dialog's open kind and prefills: the `?service=` deep
 * link, the Browser panel's open-add-data event (URL, PostgreSQL/SQL Server
 * connection, target group), and the deck.gl layer type.
 *
 * @param viewer - True for the read-only viewer preset, which ignores both the
 *   deep link and the open-add-data event.
 * @returns The open handlers and the props for `<AddDataDialog>`.
 */
export function useAddDataDialogState(viewer: boolean): AddDataDialogState {
  // `keyword` has no deep-link parameter — only the Browser panel's saved CSW
  // entries carry one — so it widens the parsed shape rather than joining it.
  const [initialService, setInitialService] = useState<
    (ServiceUrlParameter & { keyword?: string | null }) | null
  >(() =>
    viewer || typeof window === "undefined" ? null : serviceUrlParameter(window.location.search),
  );
  const [addDataKind, setAddDataKind] = useState<AddDataKind | null>(() => {
    const kind = initialService?.kind as AddDataKind | undefined;
    // Every other path that opens this dialog from outside the component
    // filters MAS-hidden sources first; a deep link must not be the way around
    // that, even though no service kind is hidden today.
    return kind && !masHidesDataSource(kind) ? kind : null;
  });
  const [addDataTargetGroupId, setAddDataTargetGroupId] = useState<string | null>(null);
  const addDataInitialLayerIdsRef = useRef<Set<string>>(new Set());
  // Every path that opens the dialog outside the OPEN_ADD_DATA_EVENT listener
  // (the Add Data menu, the command palette, the 3D-model button) is ungrouped,
  // so it must drop any group target a previous open left behind — otherwise
  // this session's layers would be swept into that stale, unrelated group when
  // the dialog closes. Only the listener sets a target, and it sets both.
  const openAddDataKind = useCallback((kind: AddDataKind) => {
    setAddDataTargetGroupId(null);
    setAddDataKind(kind);
  }, []);
  // PostgreSQL prefill (saved connection / clicked table) from the Browser panel.
  const [addDataPostgres, setAddDataPostgres] = useState<OpenAddDataPostgres | undefined>(
    undefined,
  );
  const [addDataMssql, setAddDataMssql] = useState<OpenAddDataMssql | undefined>(undefined);
  // Drop the prefill whenever the dialog isn't on the PostgreSQL source, so a
  // stale prefill can't leak into a later postgres open reached via a path that
  // sets addDataKind directly (command palette / menus) rather than through the
  // Browser-panel event that sets the prefill. The event sets the prefill and
  // kind together, so this never clears a freshly-set prefill.
  useEffect(() => {
    if (addDataKind !== "postgres") setAddDataPostgres(undefined);
  }, [addDataKind]);
  useEffect(() => {
    if (addDataKind !== "mssql") setAddDataMssql(undefined);
  }, [addDataKind]);
  // Let any panel (e.g. the Browser panel's "New connection" action) open the
  // Add Data dialog at a given kind without prop-drilling, mirroring
  // openSettingsSection. The toolbar owns the dialog + its kind state.
  useEffect(() => {
    const onOpenAddData = (event: Event) => {
      // Read-only embeds must not open Add Data via the Browser panel event.
      if (viewer) return;
      const detail = (event as CustomEvent<OpenAddDataDetail>).detail;
      // Reject kinds the Mac App Store build hides so a stray event cannot
      // open a dialog whose backing service is compiled out.
      if (detail?.kind && !masHidesDataSource(detail.kind)) {
        setInitialService(
          // An empty string is still a prefill (a saved CSW entry can carry a
          // keyword and a blank endpoint); only a missing url means "no prefill".
          detail.url !== undefined
            ? {
                kind: detail.kind,
                url: detail.url,
                layer: detail.layer ?? null,
                styleUrl: null,
                keyword: detail.keyword ?? null,
              }
            : null,
        );
        setAddDataPostgres(detail.postgres);
        setAddDataMssql(detail.mssql);
        setAddDataTargetGroupId(detail.groupId ?? null);
        addDataInitialLayerIdsRef.current = new Set(
          useAppStore.getState().layers.map((layer) => layer.id),
        );
        setAddDataKind(detail.kind);
      }
    };
    window.addEventListener(OPEN_ADD_DATA_EVENT, onOpenAddData);
    return () => window.removeEventListener(OPEN_ADD_DATA_EVENT, onOpenAddData);
  }, [viewer]);
  // Deck.gl Layer kind the Add Data dialog opens on (e.g. the 3D-model entry
  // jumps straight to the scenegraph layer type).
  const [addDataDeckVizKind, setAddDataDeckVizKind] = useState<string | undefined>(undefined);

  const prefill = addDataKind === initialService?.kind ? initialService : null;
  const dialogProps: AddDataDialogStateProps = {
    kind: addDataKind,
    initialDeckVizKind: addDataDeckVizKind,
    initialPostgres: addDataPostgres,
    initialMssql: addDataMssql,
    initialUrl: prefill ? prefill.url : undefined,
    initialLayer: prefill ? (prefill.layer ?? undefined) : undefined,
    initialStyleUrl: prefill ? (prefill.styleUrl ?? undefined) : undefined,
    initialKeyword: prefill ? (prefill.keyword ?? undefined) : undefined,
    targetGroupId: addDataTargetGroupId,
    onOpenChange: (open: boolean) => {
      if (!open) {
        if (addDataTargetGroupId) {
          const state = useAppStore.getState();
          const addedIds = state.layers
            .filter((layer) => !addDataInitialLayerIdsRef.current.has(layer.id))
            .map((layer) => layer.id);
          if (addedIds.length > 0) {
            state.moveLayersToGroup(addedIds, addDataTargetGroupId);
          }
        }
        setAddDataKind(null);
        setInitialService(null);
        setAddDataTargetGroupId(null);
        setAddDataDeckVizKind(undefined);
        setAddDataPostgres(undefined);
        setAddDataMssql(undefined);
      }
    },
  };

  return { openAddDataKind, setAddDataDeckVizKind, dialogProps };
}
