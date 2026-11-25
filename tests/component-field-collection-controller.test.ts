import { act, cleanup, fireEvent, i18n, render, screen, useAppStore, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { createElement } from "react";
import type { MapEngine, MapRenderSurface } from "@geolibre/map";
import { renderHook } from "@testing-library/react";
import { geojsonLayer } from "./helpers/layer-fixtures";
import {
  collectionMetadata,
  type CollectionSchema,
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

function addCollection(id: string) {
  useAppStore
    .getState()
    .addLayer(geojsonLayer({ id, name: id, metadata: collectionMetadata(schema) }));
}

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
