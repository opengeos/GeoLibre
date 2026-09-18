import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature } from "geojson";
import {
  adaptGeomanToMapbox,
  applyGeomanDiff,
  mapboxGeoEditorPopupFactory,
  type MapboxGlLike,
  type MapboxGeomanMap,
} from "../packages/plugins/src/plugins/geo-editor-mapbox";

// The Geo Editor runs Geoman on the Mapbox renderer by swapping the three
// members of Geoman's map adapter that construct MapLibre objects (or await
// MapLibre's promise-style `loadImage`) for mapbox-gl's. These exercise the
// swapped members against fakes of both sides, so a Geoman upgrade that
// renames a member, or a change to what the fakes are handed, reports here
// rather than as a silent no-op in the browser.

/** Records every mapbox-gl construction the swapped members make. */
function fakeMapboxGl() {
  const calls: { marker: unknown[]; popup: unknown[] } = { marker: [], popup: [] };
  class Marker {
    lngLat: [number, number] | null = null;
    map: unknown = null;
    removed = false;
    constructor(public options: unknown) {
      calls.marker.push(options);
    }
    setLngLat(lngLat: [number, number]) {
      this.lngLat = lngLat;
      return this;
    }
    addTo(map: unknown) {
      this.map = map;
      return this;
    }
    getLngLat() {
      const lngLat = this.lngLat!;
      return { toArray: () => lngLat };
    }
    getElement() {
      return (this.options as { element: HTMLElement }).element;
    }
    remove() {
      this.removed = true;
    }
  }
  class Popup {
    constructor(public options: unknown) {
      calls.popup.push(options);
    }
  }
  class LngLatBounds {
    constructor(private readonly bounds: [[number, number], [number, number]]) {}
    getSouthWest() {
      return { toArray: () => this.bounds[0] };
    }
    getNorthEast() {
      return { toArray: () => this.bounds[1] };
    }
  }
  return { gl: { Marker, Popup, LngLatBounds } as unknown as MapboxGlLike, calls, Marker };
}

/** A Geoman whose adapter still carries MapLibre's implementations (which throw). */
function fakeGeoman(mapInstance: object) {
  const adapter = {
    getMapInstance: () => mapInstance,
    project: ([lng, lat]: [number, number]) => [lng * 10, lat * 10] as [number, number],
    // Geoman's wrapper adds the source to the map inside its constructor and
    // would push MapLibre diffs through `updateData` (rejected by mapbox-gl).
    addSource: (sourceId: string, _geoJson: unknown) => ({
      id: sourceId,
      setData: async () => {
        throw new Error("Geoman's own setData");
      },
      updateData: async () => {
        throw new Error("Data to update should be a feature or a feature collection.");
      },
    }),
    createDomMarker: () => {
      throw new Error("MapLibre Marker on a mapbox-gl map");
    },
    coordBoundsToScreenBounds: () => {
      throw new Error("MapLibre LngLatBounds");
    },
    loadImage: async () => {
      throw new Error("promise-style loadImage");
    },
  };
  return {
    geoman: { mapAdapter: adapter } as unknown as Parameters<typeof adaptGeomanToMapbox>[0],
    adapter,
  };
}

function fakeImageMap() {
  const images = new Map<string, unknown>();
  /** What each mapbox-gl GeoJSON source last received through `setData`. */
  const sourceData = new Map<string, unknown>();
  const map: MapboxGeomanMap = {
    hasImage: (id: string) => images.has(id),
    addImage: ((id: string, image: unknown) => {
      images.set(id, image);
    }) as MapboxGeomanMap["addImage"],
    getSource: ((id: string) => ({
      setData: (data: unknown) => {
        sourceData.set(id, data);
      },
    })) as unknown as MapboxGeomanMap["getSource"],
  };
  return { map, images, sourceData };
}

const feature = (id: string, x: number, properties: Record<string, unknown> = {}): Feature => ({
  type: "Feature",
  properties: { __gm_id: id, ...properties },
  geometry: { type: "Point", coordinates: [x, 0] },
});

describe("adaptGeomanToMapbox", () => {
  it("builds Geoman's DOM markers with mapbox-gl's Marker on the Mapbox map", () => {
    const mapInstance = { id: "mapbox-map" };
    const { geoman, adapter } = fakeGeoman(mapInstance);
    const { gl, calls, Marker } = fakeMapboxGl();
    adaptGeomanToMapbox(geoman, gl, fakeImageMap().map);

    const element = { tagName: "DIV" } as unknown as HTMLElement;
    const marker = adapter.createDomMarker({ element, anchor: "center", draggable: false }, [1, 2]);

    // Geoman's own options go straight to mapbox-gl's constructor, and the
    // marker joins the map Geoman was built on.
    assert.deepEqual(calls.marker, [{ element, anchor: "center", draggable: false }]);
    const instance = (marker as unknown as { markerInstance: InstanceType<typeof Marker> })
      .markerInstance;
    assert.equal(instance.map, mapInstance);
    assert.deepEqual(marker.getLngLat(), [1, 2]);
    assert.equal(marker.getElement(), element);

    marker.setLngLat([3, 4]);
    assert.deepEqual(marker.getLngLat(), [3, 4]);

    marker.remove();
    assert.equal(instance.removed, true);
    // Geoman reads a removed marker's position defensively; it must not throw.
    assert.deepEqual(marker.getLngLat(), [0, 0]);
    assert.equal(marker.getElement(), null);
  });

  it("applies Geoman's source diffs itself and replaces the mapbox-gl source", async () => {
    const { map, sourceData } = fakeImageMap();
    const { geoman, adapter } = fakeGeoman(map);
    adaptGeomanToMapbox(geoman, fakeMapboxGl().gl, map);

    const wrapper = adapter.addSource("gm_main", { type: "FeatureCollection", features: [] });
    assert.equal(wrapper.id, "gm_main");

    // A shape commit arrives as an `add`; a vertex drag as an `update` of the
    // geometry; a delete as a `remove`. Geoman hands the sets and maps of its
    // hashed diff, which the mirror reads as MapLibre's worker would.
    await wrapper.updateData({
      add: new Map([["feature-1", feature("feature-1", 1, { shape: "polygon" })]]),
    } as never);
    assert.deepEqual(sourceData.get("gm_main"), {
      type: "FeatureCollection",
      features: [feature("feature-1", 1, { shape: "polygon" })],
    });

    await wrapper.updateData({
      update: new Map([
        [
          "feature-1",
          {
            id: "feature-1",
            newGeometry: { type: "Point", coordinates: [5, 5] },
            addOrUpdateProperties: [{ key: "height", value: 12 }],
          },
        ],
      ]),
    } as never);
    const [moved] = (sourceData.get("gm_main") as { features: Feature[] }).features;
    assert.deepEqual(moved.geometry, { type: "Point", coordinates: [5, 5] });
    assert.deepEqual(moved.properties, { __gm_id: "feature-1", shape: "polygon", height: 12 });

    await wrapper.updateData({ remove: new Set(["feature-1"]) } as never);
    assert.deepEqual(sourceData.get("gm_main"), { type: "FeatureCollection", features: [] });

    // A whole-collection `setData` (Geoman's transactional-set) resets the mirror.
    const reset = { type: "FeatureCollection", features: [feature("feature-2", 2)] };
    await wrapper.setData(reset as never);
    assert.equal(sourceData.get("gm_main"), reset);
    await wrapper.updateData({ add: [feature("feature-3", 3)] } as never);
    assert.deepEqual(
      (sourceData.get("gm_main") as { features: Feature[] }).features.map((f) => f.properties),
      [{ __gm_id: "feature-2" }, { __gm_id: "feature-3" }],
    );
  });

  it("applies a diff in MapLibre's order and ignores updates to unknown ids", () => {
    const features = new Map<string | number, Feature>([["a", feature("a", 0)]]);
    const added = feature("b", 1);
    applyGeomanDiff(features, {
      removeAll: true,
      add: [added],
      update: [
        { id: "a", newGeometry: { type: "Point", coordinates: [9, 9] } },
        { id: "b", removeAllProperties: true, addOrUpdateProperties: [{ key: "k", value: "v" }] },
      ],
    });
    assert.deepEqual([...features.keys()], ["b"]);
    assert.deepEqual(features.get("b")?.properties, { k: "v" });
    // The mirrored copy is Geoman's object no longer.
    assert.notEqual(features.get("b"), added);
    assert.deepEqual(added.properties, { __gm_id: "b" });
  });

  it("projects a coordinate box through mapbox-gl's LngLatBounds", () => {
    const { geoman, adapter } = fakeGeoman({});
    adaptGeomanToMapbox(geoman, fakeMapboxGl().gl, fakeImageMap().map);

    assert.deepEqual(
      adapter.coordBoundsToScreenBounds([
        [-1, -2],
        [3, 4],
      ]),
      [
        [-10, -20],
        [30, 40],
      ],
    );
  });

  it("loads Geoman's marker image through an element instead of MapLibre's promise", async () => {
    const { geoman, adapter } = fakeGeoman({});
    const { map, images } = fakeImageMap();
    adaptGeomanToMapbox(geoman, fakeMapboxGl().gl, map);

    // `Image` is a browser global; stand in a decoder that reports success on
    // the next tick, as the real one does once the data URL is decoded.
    const created: FakeImage[] = [];
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      #src = "";
      constructor() {
        created.push(this);
      }
      set src(value: string) {
        this.#src = value;
        queueMicrotask(() => this.onload?.());
      }
      get src() {
        return this.#src;
      }
    }
    const previous = (globalThis as { Image?: unknown }).Image;
    (globalThis as { Image?: unknown }).Image = FakeImage;
    try {
      await adapter.loadImage({ id: "default-marker", image: "data:image/png;base64,AAAA" });
      assert.equal(created.length, 1);
      assert.equal(created[0].src, "data:image/png;base64,AAAA");
      assert.equal(images.get("default-marker"), created[0]);

      // A second load of the same id is a no-op (Geoman calls it on every init).
      await adapter.loadImage({ id: "default-marker", image: "data:image/png;base64,BBBB" });
      assert.equal(created.length, 1);
    } finally {
      (globalThis as { Image?: unknown }).Image = previous;
    }
  });
});

describe("mapboxGeoEditorPopupFactory", () => {
  it("hands the editor's popup options to mapbox-gl's Popup", () => {
    const { gl, calls } = fakeMapboxGl();
    const createPopup = mapboxGeoEditorPopupFactory(gl);
    const options = {
      maxWidth: "240px",
      closeButton: false,
      closeOnClick: false,
      className: "geo-editor-rotate-popup",
    };
    const popup = createPopup(options);
    assert.deepEqual(calls.popup, [options]);
    assert.ok(popup instanceof (gl.Popup as unknown as new (...args: unknown[]) => unknown));
  });
});
