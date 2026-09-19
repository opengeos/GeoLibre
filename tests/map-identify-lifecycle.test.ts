import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import {
  createIdentifyPopupState,
  isRestoringIdentifySelection,
  removeIdentifyPopup,
  restoreIdentifySelection,
  type IdentifyPopupState,
} from "../packages/map/src/map-identify-lifecycle";
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
  assert.equal(isRestoringIdentifySelection(), false);
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

  it("reports restoration only during the restore sequence", () => {
    seedMatchingSelection();
    const observations: boolean[] = [];
    useAppStore.setState({
      selectLayer: () => observations.push(isRestoringIdentifySelection()),
      selectFeatures: () => observations.push(isRestoringIdentifySelection()),
    });

    assert.equal(isRestoringIdentifySelection(), false);
    restoreIdentifySelection(popupState());
    assert.deepEqual(observations, [true, true]);
    assert.equal(isRestoringIdentifySelection(), false);
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
