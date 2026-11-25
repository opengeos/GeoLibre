import { act, cleanup, fireEvent, i18n, render, screen, useAppStore, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, it, mock } from "node:test";
import { createElement } from "react";
import type { MapEngine, MapRenderSurface } from "@geolibre/map";
import { renderHook } from "@testing-library/react";
import { geojsonLayer } from "./helpers/layer-fixtures";
import {
  collectionMetadata,
  type CollectionSchema,
  type GeometryType,
} from "../apps/geolibre-desktop/src/lib/field-collection";

const { useFieldCollectionController } =
  await import("../apps/geolibre-desktop/src/hooks/useFieldCollectionController");
const { FieldCollectionDialog } =
  await import("../apps/geolibre-desktop/src/components/layout/FieldCollectionDialog");
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const readerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "FileReader");
const schema: CollectionSchema = {
  fields: [{ key: "condition", label: "Condition", type: "text", required: true }],
};

function addCollection(id: string, geometry: GeometryType = "point", fields = schema) {
  useAppStore
    .getState()
    .addLayer(geojsonLayer({ id, name: id, metadata: collectionMetadata(fields, geometry) }));
}

// A table whose records carry a link to a parent record.
const linkedSchema: CollectionSchema = {
  fields: [
    { key: "parent_id", label: "Parent", type: "text", required: false },
    { key: "condition", label: "Condition", type: "text", required: false },
  ],
};

function hardware() {
  const requests: { resolve: PositionCallback; reject?: PositionErrorCallback | null }[] = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent: "Field collection test",
      geolocation: {
        getCurrentPosition(resolve: PositionCallback, reject?: PositionErrorCallback | null) {
          requests.push({ resolve, reject });
        },
      },
    },
  });
  return requests;
}

function position(longitude = -83.92): GeolocationPosition {
  return {
    coords: {
      latitude: 35.95,
      longitude,
      accuracy: 2,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      toJSON: () => ({}),
    },
    timestamp: 1000,
    toJSON: () => ({}),
  };
}

function controller(mapControllerRef: { current: MapEngine | null } = { current: null }) {
  const changes: boolean[] = [];
  const onOpenChange = (open: boolean) => {
    changes.push(open);
  };
  const hook = renderHook(
    ({ open }) =>
      useFieldCollectionController({
        open,
        onOpenChange,
        mapControllerRef,
        mapReadyGeneration: 0,
      }),
    { initialProps: { open: true } },
  );
  return { ...hook, changes };
}

function capture(hook: ReturnType<typeof controller>) {
  const model = hook.result.current.capture;
  assert.ok(model, "capture requires a selected collection schema");
  return model;
}

const containers: HTMLElement[] = [];

function liveMap() {
  const container = document.createElement("div");
  const canvas = document.createElement("canvas");
  container.append(canvas);
  document.body.append(container);
  containers.push(container);
  const flights: unknown[] = [];
  let stopped = 0;
  const surface: MapRenderSurface = {
    getContainer: () => container,
    getCanvas: () => canvas,
    getBearing: () => 0,
    project: ([lng, lat]) => ({ x: lng, y: lat }),
    unproject: ([x, y]) => ({ lng: x, lat: y }),
    redraw: () => {},
  };
  const engine = {
    getRenderSurface: () => surface,
    readView: () => ({ zoom: 12 }),
    flyTo: (options: unknown) => {
      flights.push(options);
    },
    onCameraMove: () => () => {
      stopped++;
    },
  } as unknown as MapEngine;
  return { ref: { current: engine }, container, flights, stopped: () => stopped };
}

class PendingReader {
  static pending: PendingReader[] = [];
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(_file: File) {
    PendingReader.pending.push(this);
  }
  finish(name: string) {
    this.result = `data:image/jpeg;base64,${btoa(name)}`;
    this.onload?.();
  }
}

beforeEach(() => {
  window.localStorage.clear();
  useAppStore.getState().newProject();
  PendingReader.pending = [];
});

afterEach(() => {
  mock.restoreAll();
  cleanup();
  for (const container of containers.splice(0)) container.remove();
  for (const [key, descriptor] of [
    ["navigator", navigatorDescriptor],
    ["FileReader", readerDescriptor],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

it("removes a live capture marker and its camera subscription on unmount", async () => {
  addCollection("A");
  const requests = hardware();
  const map = liveMap();
  const hook = controller(map.ref);
  act(() => capture(hook).onUseGps());
  await act(async () => requests[0].resolve(position()));
  assert.equal(map.flights.length, 1);
  assert.equal(map.container.children.length, 2);
  hook.unmount();
  assert.equal(map.container.children.length, 1);
  assert.equal(map.stopped(), 1);
});

it("does not recreate a marker or move the live map after its owner unmounts", async () => {
  addCollection("A");
  const requests = hardware();
  const map = liveMap();
  const hook = controller(map.ref);
  act(() => capture(hook).onUseGps());
  hook.unmount();
  await act(async () => requests[0].resolve(position()));
  assert.equal(map.flights.length, 0);
  assert.equal(map.container.children.length, 1);
  assert.equal(map.stopped(), 0);
});

it("creates a collection and validates attributes before saving a GPS point without a map", async () => {
  const requests = hardware();
  const hook = controller();
  assert.equal(hook.result.current.capture, null);
  assert.equal(hook.result.current.inSetup, true);
  act(() => {
    const field = hook.result.current.setup.newDraft();
    hook.result.current.setup.onLayerName("Observations");
    hook.result.current.setup.onDrafts([{ ...field, label: "Condition", required: true }]);
  });
  act(() => hook.result.current.setup.onCreate());
  const id = hook.result.current.target.selected;
  assert.ok(id);
  act(() => capture(hook).onUseGps());
  assert.equal(capture(hook).locating, true);
  await act(async () => requests[0].resolve(position()));
  assert.deepEqual(capture(hook).pending, [[-83.92, 35.95]]);
  act(() => capture(hook).onSave());
  assert.equal(capture(hook).errors.condition, "required");
  assert.equal(useAppStore.getState().layers[0].geojson?.features.length, 0);
  act(() => capture(hook).setValue("condition", "Intact"));
  act(() => capture(hook).onSave());
  const saved = useAppStore.getState().layers.find((layer) => layer.id === id)?.geojson?.features;
  assert.equal(saved?.length, 1);
  assert.deepEqual(saved?.[0].geometry, { type: "Point", coordinates: [-83.92, 35.95] });
  assert.equal(saved?.[0].properties?.condition, "Intact");
  assert.equal(capture(hook).pending, null);
});

it("drops a pending GPS result when its target changes and accepts the next target's request", async () => {
  addCollection("A");
  addCollection("B");
  const requests = hardware();
  const hook = controller();
  act(() => capture(hook).onUseGps());
  act(() => hook.result.current.target.onChange("B"));
  act(() => capture(hook).onUseGps());
  await act(async () => requests[0].resolve(position(-84)));
  assert.equal(capture(hook).pending, null);
  assert.equal(capture(hook).locating, true);
  await act(async () => requests[1].resolve(position(-82)));
  assert.deepEqual(capture(hook).pending, [[-82, 35.95]]);
  assert.equal(hook.result.current.target.selected, "B");
});

it("preserves captured work across dismissal but clears it on a project change", async () => {
  addCollection("A");
  const requests = hardware();
  const hook = controller();
  act(() => capture(hook).onUseGps());
  await act(async () => requests[0].resolve(position()));
  act(() => capture(hook).setValue("condition", "Intact"));
  act(() => hook.result.current.onDialogOpenChange(false));
  hook.rerender({ open: false });
  assert.equal(hook.result.current.quickOpen, true);
  hook.rerender({ open: true });
  assert.deepEqual(capture(hook).pending, [[-83.92, 35.95]]);
  assert.equal(capture(hook).values.condition, "Intact");
  act(() => useAppStore.getState().newProject());
  assert.equal(hook.result.current.capture, null);
  assert.equal(hook.result.current.inSetup, true);
});

it("Done ends the session and hides quick-open while preserving collection layers", () => {
  addCollection("A");
  const hook = controller();
  const layers = useAppStore.getState().layers;
  act(() => hook.result.current.onDialogOpenChange(false));
  hook.rerender({ open: false });
  assert.equal(hook.result.current.quickOpen, true);
  act(() => hook.result.current.onDone());
  assert.equal(hook.changes.at(-1), false);
  assert.equal(hook.result.current.quickOpen, false);
  assert.equal(useAppStore.getState().layers, layers);
});

it("keeps a new photo read busy when an older target's photo finishes", async () => {
  addCollection("A");
  addCollection("B");
  hardware();
  Object.defineProperty(globalThis, "FileReader", { configurable: true, value: PendingReader });
  const hook = controller();
  const inputView = render(
    createElement("input", { type: "file", onChange: capture(hook).onPhotos }),
  );
  const input = inputView.container.querySelector("input");
  assert.ok(input);
  fireEvent.change(input, { target: { files: [new File(["old"], "old.jpg")] } });
  assert.equal(capture(hook).readingPhotos, true);
  act(() => hook.result.current.target.onChange("B"));
  fireEvent.change(input, { target: { files: [new File(["new"], "new.jpg")] } });
  await act(async () => PendingReader.pending[0].finish("old"));
  assert.equal(capture(hook).readingPhotos, true);
  assert.equal(capture(hook).photos.length, 0);
  await act(async () => PendingReader.pending[1].finish("new"));
  assert.equal(capture(hook).readingPhotos, false);
  assert.deepEqual(
    capture(hook).photos.map((photo) => photo.name),
    ["new.jpg"],
  );
});

it("saves a point from the rendered collection form", async () => {
  addCollection("Observations");
  const requests = hardware();
  render(
    createElement(FieldCollectionDialog, {
      open: true,
      onOpenChange: () => {},
      mapControllerRef: { current: null },
      mapReadyGeneration: 0,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: i18n.t("fieldCollection.useGps") }));
  await act(async () => requests[0].resolve(position()));
  const field = await screen.findByLabelText(/Condition/);
  fireEvent.change(field, { target: { value: "Observed" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("fieldCollection.save.point") }));
  await waitFor(() => assert.equal(useAppStore.getState().layers[0].geojson?.features.length, 1));
  assert.equal(
    useAppStore.getState().layers[0].geojson?.features[0].properties?.condition,
    "Observed",
  );
});

it("drops a related-record prefill when its child table is deleted and the target falls back", () => {
  addCollection("Parent", "none", linkedSchema);
  addCollection("Child", "none", linkedSchema);
  // Step past the double-save guard between saves without waiting for it.
  let now = 10_000;
  mock.method(Date, "now", () => now);
  const hook = controller();
  assert.equal(hook.result.current.target.selected, "Parent");
  act(() => capture(hook).setValue("condition", "parent"));
  act(() => capture(hook).onSave());
  const related = hook.result.current.related;
  assert.ok(related, "a saved parent offers Add Related");
  act(() => related.onAdd("Child", { parent_id: "p-1" }));
  assert.equal(hook.result.current.target.selected, "Child");
  // Consecutive saves in the same related workflow keep the link.
  now += 1000;
  act(() => capture(hook).setValue("condition", "child"));
  act(() => capture(hook).onSave());
  assert.equal(capture(hook).values.parent_id, "p-1");
  act(() => hook.result.current.onDialogOpenChange(false));
  hook.rerender({ open: false });
  act(() => useAppStore.getState().removeLayer("Child"));
  assert.equal(hook.result.current.target.selected, "Parent");
  hook.rerender({ open: true });
  now += 1000;
  act(() => capture(hook).setValue("condition", "another parent"));
  act(() => capture(hook).onSave());
  const saved = useAppStore.getState().layers.find((layer) => layer.id === "Parent")?.geojson;
  assert.equal(saved?.features.length, 2);
  assert.equal(saved?.features[1].properties?.parent_id ?? "", "");
  assert.equal(capture(hook).values.parent_id, undefined);
});

it("keeps an edited table record across dismissal", () => {
  addCollection("Table", "none");
  const hook = controller();
  act(() => capture(hook).setValue("condition", "Typed"));
  act(() => hook.result.current.onDialogOpenChange(false));
  hook.rerender({ open: false });
  hook.rerender({ open: true });
  assert.equal(capture(hook).values.condition, "Typed");
});

it("keeps a capture whose photo is still being read across dismissal", async () => {
  addCollection("A");
  hardware();
  Object.defineProperty(globalThis, "FileReader", { configurable: true, value: PendingReader });
  const hook = controller();
  const inputView = render(
    createElement("input", { type: "file", onChange: capture(hook).onPhotos }),
  );
  const input = inputView.container.querySelector("input");
  assert.ok(input);
  fireEvent.change(input, { target: { files: [new File(["photo"], "photo.jpg")] } });
  act(() => hook.result.current.onDialogOpenChange(false));
  hook.rerender({ open: false });
  hook.rerender({ open: true });
  assert.equal(capture(hook).readingPhotos, true);
  await act(async () => PendingReader.pending[0].finish("photo"));
  assert.equal(capture(hook).readingPhotos, false);
  assert.deepEqual(
    capture(hook).photos.map((photo) => photo.name),
    ["photo.jpg"],
  );
});

it("clears the GPS busy state when a dismissal keeps a setup draft", async () => {
  addCollection("A");
  const requests = hardware();
  const hook = controller();
  act(() => hook.result.current.setup.onLayerName("Half-composed"));
  act(() => capture(hook).onUseGps());
  assert.equal(capture(hook).locating, true);
  act(() => hook.result.current.onDialogOpenChange(false));
  hook.rerender({ open: false });
  hook.rerender({ open: true });
  assert.equal(hook.result.current.setup.layerName, "Half-composed");
  assert.equal(capture(hook).locating, false);
  await act(async () => requests[0].resolve(position()));
  assert.equal(capture(hook).pending, null);
});

for (const exit of ["finish", "cancel"] as const) {
  it(`drops a GPS vertex that arrives after drawing is ${exit === "finish" ? "finished" : "cancelled"}`, async () => {
    addCollection("Line", "line");
    const requests = hardware();
    const map = liveMap();
    const hook = controller(map.ref);
    act(() => capture(hook).onStartDrawing());
    hook.rerender({ open: false });
    for (const [index, lng] of [-84, -83].entries()) {
      act(() => hook.result.current.draw?.onAddGps());
      await act(async () => requests[index].resolve(position(lng)));
    }
    assert.equal(hook.result.current.draw?.count, 2);
    act(() => hook.result.current.draw?.onAddGps());
    assert.equal(hook.result.current.draw?.locating, true);
    const draw = hook.result.current.draw;
    assert.ok(draw);
    act(() => (exit === "finish" ? draw.onFinish() : draw.onCancel()));
    hook.rerender({ open: true });
    assert.equal(capture(hook).locating, false);
    const preview = map.container.querySelector("[data-field-collection-preview]");
    await act(async () => requests[2].resolve(position(-82)));
    assert.equal(map.flights.length, 2);
    if (exit === "finish") {
      assert.deepEqual(capture(hook).pending, [
        [-84, 35.95],
        [-83, 35.95],
      ]);
      assert.equal(map.container.querySelector("[data-field-collection-preview]"), preview);
      assert.equal(preview?.querySelectorAll("circle").length, 2);
    } else {
      assert.equal(preview, null);
      assert.equal(map.container.querySelector("[data-field-collection-preview]"), null);
    }
  });
}

it("releases Save only when the attachment read that held it finishes", () => {
  addCollection("A");
  addCollection("B");
  const hook = controller();
  // Pick a picture in A, leave for B and come back: the record key is the same.
  act(() => capture(hook).onAttachmentReading(1, 1));
  act(() => hook.result.current.target.onChange("B"));
  act(() => hook.result.current.target.onChange("A"));
  act(() => capture(hook).onAttachmentReading(1, 2));
  assert.equal(capture(hook).readingPhotos, true);
  // The first read's late completion must not release the second's hold.
  act(() => capture(hook).onAttachmentReading(-1, 1));
  assert.equal(capture(hook).readingPhotos, true);
  act(() => capture(hook).onAttachmentReading(-1, 2));
  assert.equal(capture(hook).readingPhotos, false);
});
