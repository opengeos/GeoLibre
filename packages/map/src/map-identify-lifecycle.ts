import { useAppStore } from "@geolibre/core";

/** Selection ownership recorded while an Identify popup is open. */
export interface IdentifyPopupState {
  identifiedLayerId: string;
  identifiedFeatureId: string | null;
  previousSelectedLayerId: string | null;
  previousSelectedFeatureId: string | null;
  previousSelectedFeatureIds: string[];
  onClose: () => void;
}

/** The engine-neutral popup surface needed by the Identify lifecycle. */
export interface PopupLike {
  remove(): unknown;
  off(type: "close", listener: () => void): unknown;
}

let restoringIdentifySelection = false;

/** Whether the store is synchronously restoring the selection from an Identify popup. */
export function isRestoringIdentifySelection(): boolean {
  return restoringIdentifySelection;
}

/** Snapshot the current selection before an Identify result takes ownership of it. */
export function createIdentifyPopupState(snapshot: {
  layerId: string;
  featureId: string | null;
  onClose: () => void;
}): IdentifyPopupState {
  const current = useAppStore.getState();
  return {
    identifiedLayerId: snapshot.layerId,
    identifiedFeatureId: snapshot.featureId,
    previousSelectedLayerId: current.selectedLayerId,
    previousSelectedFeatureId: current.selectedFeatureId,
    previousSelectedFeatureIds: current.selectedFeatureIds,
    onClose: snapshot.onClose,
  };
}

/** Restore the selection owned before an Identify popup opened. */
export function restoreIdentifySelection(
  selection: IdentifyPopupState,
  options: { force?: boolean } = {},
): void {
  const next = useAppStore.getState();
  // Only undo the popup's own selection; a layer or feature the user picked
  // while the popup was open is theirs to keep.
  if (
    !options.force &&
    (next.selectedLayerId !== selection.identifiedLayerId ||
      next.selectedFeatureId !== selection.identifiedFeatureId ||
      next.selectedFeatureIds.length !== (selection.identifiedFeatureId ? 1 : 0) ||
      (selection.identifiedFeatureId !== null &&
        next.selectedFeatureIds[0] !== selection.identifiedFeatureId))
  ) {
    return;
  }
  const previousLayerExists =
    selection.previousSelectedLayerId !== null &&
    next.layers.some((layer) => layer.id === selection.previousSelectedLayerId);
  restoringIdentifySelection = true;
  try {
    // selectLayer also clears the feature selection.
    next.selectLayer(previousLayerExists ? selection.previousSelectedLayerId : null);
    if (previousLayerExists && selection.previousSelectedFeatureIds.length > 0) {
      next.selectFeatures(
        selection.previousSelectedFeatureIds,
        selection.previousSelectedFeatureId,
      );
    }
  } finally {
    restoringIdentifySelection = false;
  }
}

/** Remove an Identify popup and optionally restore the selection it owns. */
export function removeIdentifyPopup(
  popup: PopupLike | null | undefined,
  state: IdentifyPopupState | null | undefined,
  options: { restore?: boolean; forceRestore?: boolean } = {},
): void {
  if (popup && state) popup.off("close", state.onClose);
  popup?.remove();
  if (state && options.restore !== false) {
    restoreIdentifySelection(state, { force: options.forceRestore });
  }
}
