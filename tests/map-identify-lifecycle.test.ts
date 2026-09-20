import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import {
  consumePendingIdentifyRestore,
  createIdentifyPopupState,
  removeIdentifyPopup,
  restoreIdentifySelection,
  type IdentifyPopupState,
} from "../packages/map/src/map-identify-lifecycle";
import { selectionFitKey } from "../packages/map/src/map-selection";
import { geojsonLayer } from "./helpers/layer-fixtures";

const originalActions = {
  selectLayer: useAppStore.getState().selectLayer,
  selectFeatures: useAppStore.getState().selectFeatures,
};

afterEach(() => {
  useAppStore.setState({
    layers: [],
    selectedLayerId: null,
    selectedFeatureId: null,
    selectedFeatureIds: [],
    ...originalActions,
  });
  // Drop any restore marker a test left behind so it can't leak across tests.
  consumePendingIdentifyRestore("__drain__");
});

function popupState(patch: Partial<IdentifyPopupState> = {}): IdentifyPopupState {
  return {
    identifiedLayerId: "identified",
    identifiedFeatureId: "hit",
    previousSelectedLayerId: "previous",
    previousSelectedFeatureId: "b",
    previousSelectedFeatureIds: ["a", "b"],
    onClose: () => {},
    ...patch,
  };
}

function seedMatchingSelection(): void {
  useAppStore.setState({
    layers: [geojsonLayer({ id: "identified" }), geojsonLayer({ id: "previous" })],
    selectedLayerId: "identified",
    selectedFeatureId: "hit",
    selectedFeatureIds: ["hit"],
    ...originalActions,
  });
}

function stubIdentifyPopup() {
  let closeListener: (() => void) | undefined;
  return {
    once: (type: "close", listener: () => void) => {
      assert.equal(type, "close");
      closeListener = listener;
    },
    off: (type: "close", listener: () => void) => {
      assert.equal(type, "close");
      if (closeListener === listener) closeListener = undefined;
    },
    remove: () => closeListener?.(),
    userDismiss: () => closeListener?.(),
  };
}

describe("identify popup selection lifecycle", () => {
  it("snapshots the current store selection and new Identify selection", () => {
    useAppStore.setState({
      selectedLayerId: "previous",
      selectedFeatureId: "b",
      selectedFeatureIds: ["a", "b"],
    });
    const onClose = () => {};

    assert.deepEqual(
      createIdentifyPopupState({
        layerId: "identified",
        featureId: "hit",
        onClose,
      }),
      popupState({ onClose }),
    );
  });

  it("restores when the current selection still matches, with and without force", () => {
    for (const force of [false, true]) {
      seedMatchingSelection();
      restoreIdentifySelection(popupState(), { force });
      const next = useAppStore.getState();
      assert.equal(next.selectedLayerId, "previous");
      assert.equal(next.selectedFeatureId, "b");
      assert.deepEqual(next.selectedFeatureIds, ["a", "b"]);
    }
  });

  it("restores the previous selection when closing a popup for an empty-string feature id", () => {
    useAppStore.setState({
      layers: [geojsonLayer({ id: "identified" }), geojsonLayer({ id: "previous" })],
      selectedLayerId: "previous",
      selectedFeatureId: "b",
      selectedFeatureIds: ["a", "b"],
      ...originalActions,
    });
    const state = createIdentifyPopupState({
      layerId: "identified",
      featureId: "",
      onClose: () => {},
    });
    const store = useAppStore.getState();
    store.selectLayer("identified");
    store.selectFeature("");
    assert.deepEqual(useAppStore.getState().selectedFeatureIds, [""]);

    removeIdentifyPopup({ off: () => {}, remove: () => {} }, state);

    const next = useAppStore.getState();
    assert.equal(next.selectedLayerId, "previous");
    assert.equal(next.selectedFeatureId, "b");
    assert.deepEqual(next.selectedFeatureIds, ["a", "b"]);
  });

  it("keeps an independent user selection while the popup is open", () => {
    seedMatchingSelection();
    useAppStore.setState({
      selectedLayerId: "user-layer",
      selectedFeatureId: "user-feature",
      selectedFeatureIds: ["user-feature"],
    });

    restoreIdentifySelection(popupState());

    const next = useAppStore.getState();
    assert.equal(next.selectedLayerId, "user-layer");
    assert.equal(next.selectedFeatureId, "user-feature");
    assert.deepEqual(next.selectedFeatureIds, ["user-feature"]);
  });

  it("owns only a resolved single-layer hit until genuine dismissal", () => {
    useAppStore.setState({
      layers: [geojsonLayer({ id: "identified" }), geojsonLayer({ id: "previous" })],
      selectedLayerId: "previous",
      selectedFeatureId: "b",
      selectedFeatureIds: ["a", "b"],
      ...originalActions,
    });

    const openHit = () => {
      const popup = stubIdentifyPopup();
      let state: IdentifyPopupState;
      const onClose = () => restoreIdentifySelection(state);
      state = createIdentifyPopupState({
        layerId: "identified",
        featureId: "hit",
        onClose,
      });
      popup.once("close", onClose);
      const store = useAppStore.getState();
      store.selectLayer("identified");
      store.selectFeature("hit");
      return { popup, state };
    };

    const first = openHit();
    assert.equal(first.state.previousSelectedLayerId, "previous");
    assert.equal(first.state.previousSelectedFeatureId, "b");
    assert.deepEqual(first.state.previousSelectedFeatureIds, ["a", "b"]);
    first.popup.userDismiss();
    assert.equal(useAppStore.getState().selectedLayerId, "previous");
    assert.equal(useAppStore.getState().selectedFeatureId, "b");
    assert.deepEqual(useAppStore.getState().selectedFeatureIds, ["a", "b"]);

    const independentlyChanged = openHit();
    useAppStore.getState().selectLayer("previous");
    useAppStore.getState().selectFeature("a");
    independentlyChanged.popup.userDismiss();
    assert.equal(useAppStore.getState().selectedLayerId, "previous");
    assert.equal(useAppStore.getState().selectedFeatureId, "a");

    const missed = openHit();
    removeIdentifyPopup(missed.popup, missed.state, { restore: false });
    useAppStore.getState().selectFeature(null);
    assert.equal(useAppStore.getState().selectedLayerId, "identified");
    assert.equal(useAppStore.getState().selectedFeatureId, null);

    const aborted = openHit();
    removeIdentifyPopup(aborted.popup, aborted.state, { restore: false });
    assert.equal(useAppStore.getState().selectedLayerId, "identified");
    assert.equal(useAppStore.getState().selectedFeatureId, "hit");
  });

  it("falls back to null when the previous layer no longer exists", () => {
    useAppStore.setState({
      layers: [geojsonLayer({ id: "identified" })],
      selectedLayerId: "identified",
      selectedFeatureId: "hit",
      selectedFeatureIds: ["hit"],
      ...originalActions,
    });

    restoreIdentifySelection(popupState());

    const next = useAppStore.getState();
    assert.equal(next.selectedLayerId, null);
    assert.equal(next.selectedFeatureId, null);
    assert.deepEqual(next.selectedFeatureIds, []);
  });

  it("marks a restore for a synchronous store subscriber exactly once", () => {
    seedMatchingSelection();
    const observations: boolean[] = [];
    const unsubscribe = useAppStore.subscribe((state) =>
      observations.push(consumePendingIdentifyRestore(selectionFitKey(state))),
    );
    try {
      restoreIdentifySelection(popupState());
    } finally {
      unsubscribe();
    }
    // selectLayer's intermediate (feature-less) state leaves the marker; the
    // selectFeatures write that completes the restore consumes it.
    assert.deepEqual(observations, [false, true]);
    assert.equal(consumePendingIdentifyRestore(selectionFitKey(useAppStore.getState())), false);
  });

  it("keeps the restore observable for a deferred reader exactly once", async () => {
    seedMatchingSelection();
    restoreIdentifySelection(popupState());
    // A React effect reads the selection only after the restore has returned.
    await Promise.resolve();
    const key = selectionFitKey(useAppStore.getState());
    assert.equal(key, JSON.stringify(["previous", ["a", "b"]]));
    assert.equal(consumePendingIdentifyRestore(key), true);
    assert.equal(consumePendingIdentifyRestore(key), false);
  });

  it("drops the restore marker when a different selection supersedes it", () => {
    for (const superseding of [null, JSON.stringify(["previous", ["c"]])]) {
      seedMatchingSelection();
      restoreIdentifySelection(popupState());
      const restoredKey = selectionFitKey(useAppStore.getState());
      // The marker is single-use; a non-matching read clears it.
      assert.equal(consumePendingIdentifyRestore(superseding), false);
      assert.equal(consumePendingIdentifyRestore(restoredKey), false);
    }
  });

  it("does not mark a skipped restore or one that highlights nothing", () => {
    const restoredKey = JSON.stringify(["previous", ["a", "b"]]);
    seedMatchingSelection();
    useAppStore.setState({ selectedFeatureId: "user", selectedFeatureIds: ["user"] });
    restoreIdentifySelection(popupState());
    assert.equal(consumePendingIdentifyRestore(restoredKey), false);

    seedMatchingSelection();
    restoreIdentifySelection(
      popupState({ previousSelectedFeatureId: null, previousSelectedFeatureIds: [] }),
    );
    assert.equal(useAppStore.getState().selectedLayerId, "previous");
    assert.equal(consumePendingIdentifyRestore(restoredKey), false);
  });

  it("removes without restoring when restore is false", () => {
    let offCalls = 0;
    let removeCalls = 0;
    let selectLayerCalls = 0;
    seedMatchingSelection();
    useAppStore.setState({
      selectLayer: () => {
        selectLayerCalls += 1;
      },
    });
    const state = popupState();
    const popup = {
      off: (type: "close", listener: () => void) => {
        assert.equal(type, "close");
        assert.equal(listener, state.onClose);
        offCalls += 1;
      },
      remove: () => {
        removeCalls += 1;
      },
    };

    removeIdentifyPopup(popup, state, { restore: false });

    assert.equal(offCalls, 1);
    assert.equal(removeCalls, 1);
    assert.equal(selectLayerCalls, 0);
  });
});
