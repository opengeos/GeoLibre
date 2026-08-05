import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PopupOptions } from "maplibre-gl";
import {
  GLOBE_POPUP_OCCLUDED_CLASS,
  installGlobePopupOcclusion,
  type MapLibrePopupNamespace,
} from "../packages/map/src/globe-popup-occlusion";

interface FakeContainer {
  classList: DOMTokenList;
  style: {
    opacity: string;
    pointerEvents: string;
    visibility: string;
  };
}

interface FakeTransform {
  isLocationOccluded: (lngLat?: unknown) => boolean;
}

/**
 * Where the transform hangs off the map: v5 exposes `map.transform`, v6 moved
 * it to `map._camera.transform` when `Map` stopped extending `Camera`.
 */
type TransformShape = "v5" | "v6";

type TestPopup = {
  _container: HTMLElement;
  _map: unknown;
  _updateOpacity: () => void;
  options: PopupOptions;
  addTo: (map: unknown) => unknown;
  getLngLat: () => unknown;
};

function createClassList(): DOMTokenList {
  const classes = new Set<string>();
  return {
    add: (...tokens: string[]) => {
      for (const token of tokens) classes.add(token);
    },
    remove: (...tokens: string[]) => {
      for (const token of tokens) classes.delete(token);
    },
    contains: (token: string) => classes.has(token),
    toggle: (token: string, force?: boolean) => {
      const next = force ?? !classes.has(token);
      if (next) classes.add(token);
      else classes.delete(token);
      return next;
    },
  } as unknown as DOMTokenList;
}

function createContainer(): HTMLElement {
  const container: FakeContainer = {
    classList: createClassList(),
    style: {
      opacity: "",
      pointerEvents: "auto",
      visibility: "visible",
    },
  };
  return container as unknown as HTMLElement;
}

function createMap(transform: FakeTransform, shape: TransformShape): unknown {
  return shape === "v6" ? { _camera: { transform } } : { transform };
}

function neverOccluded(): FakeTransform {
  return { isLocationOccluded: () => false };
}

function createMaplibreStub(shape: TransformShape): MapLibrePopupNamespace {
  class FakePopup {
    _container = createContainer();
    _map: { _camera?: { transform: FakeTransform }; transform?: FakeTransform } = {};
    _updateOpacity: () => void;
    options: PopupOptions;

    constructor(options: PopupOptions = {}) {
      this.options = options;
      // MapLibre assigns _updateOpacity as an instance arrow in the Popup
      // constructor, which is why the patch wraps per instance, not on the
      // prototype. Each version reads the transform from its own location.
      this._updateOpacity = () => {
        if (this.options.locationOccludedOpacity === undefined) return;
        const transform = shape === "v6" ? this._map._camera?.transform : this._map.transform;
        if (transform?.isLocationOccluded()) {
          this._container.style.opacity = `${this.options.locationOccludedOpacity}`;
        } else {
          this._container.style.opacity = "";
        }
      };
    }

    // Mirrors MapLibre: addTo attaches the map, then runs an update pass.
    addTo(map: unknown) {
      this._map = map as FakePopup["_map"];
      this._updateOpacity();
      return this;
    }

    getLngLat() {
      return { lng: 0, lat: 0 };
    }
  }

  return { Popup: FakePopup } as unknown as MapLibrePopupNamespace;
}

/** Construct a popup and put it on a map, the way real code reaches occlusion. */
function openPopup(
  maplibre: MapLibrePopupNamespace,
  shape: TransformShape,
  options?: PopupOptions,
  transform: FakeTransform = neverOccluded(),
): TestPopup {
  const popup = new maplibre.Popup(options) as unknown as TestPopup;
  popup.addTo(createMap(transform, shape));
  return popup;
}

for (const shape of ["v5", "v6"] as const) {
  describe(`installGlobePopupOcclusion (maplibre ${shape} transform)`, () => {
    it("defaults popups to hidden globe occlusion and restores interaction", () => {
      const maplibre = createMaplibreStub(shape);
      installGlobePopupOcclusion(maplibre);

      const popup = openPopup(maplibre, shape);
      assert.equal(popup.options.locationOccludedOpacity, 0);

      popup._map = createMap({ isLocationOccluded: () => true }, shape);
      popup._updateOpacity();

      assert.equal(popup._container.style.opacity, "0");
      assert.equal(popup._container.style.pointerEvents, "none");
      assert.equal(popup._container.style.visibility, "hidden");
      assert.equal(popup._container.classList.contains(GLOBE_POPUP_OCCLUDED_CLASS), true);

      popup._map = createMap({ isLocationOccluded: () => false }, shape);
      popup._updateOpacity();

      assert.equal(popup._container.style.opacity, "");
      assert.equal(popup._container.style.pointerEvents, "auto");
      assert.equal(popup._container.style.visibility, "visible");
      assert.equal(popup._container.classList.contains(GLOBE_POPUP_OCCLUDED_CLASS), false);
    });

    it("hides an already-occluded popup on the first frame after addTo", () => {
      const maplibre = createMaplibreStub(shape);
      installGlobePopupOcclusion(maplibre);

      const popup = openPopup(maplibre, shape, undefined, { isLocationOccluded: () => true });

      assert.equal(popup._container.style.opacity, "0");
      assert.equal(popup._container.style.pointerEvents, "none");
      assert.equal(popup._container.classList.contains(GLOBE_POPUP_OCCLUDED_CLASS), true);
    });

    it("respects explicit nonzero locationOccludedOpacity values", () => {
      const maplibre = createMaplibreStub(shape);
      installGlobePopupOcclusion(maplibre);

      const popup = openPopup(maplibre, shape, { locationOccludedOpacity: 0.35 });

      popup._map = createMap({ isLocationOccluded: () => true }, shape);
      popup._updateOpacity();

      assert.equal(popup.options.locationOccludedOpacity, 0.35);
      assert.equal(popup._container.style.opacity, "0.35");
      assert.equal(popup._container.style.pointerEvents, "auto");
      assert.equal(popup._container.style.visibility, "visible");
      assert.equal(popup._container.classList.contains(GLOBE_POPUP_OCCLUDED_CLASS), false);
    });
  });
}

describe("installGlobePopupOcclusion", () => {
  const shape = "v6" as const;

  // Real browsers normalize " 0 " to "0"; the fake container stores it verbatim.
  for (const opacity of ["0", "0.0", " 0 "]) {
    it(`suppresses interaction for zero opacity string ${opacity}`, () => {
      const maplibre = createMaplibreStub(shape);
      installGlobePopupOcclusion(maplibre);

      const popup = openPopup(
        maplibre,
        shape,
        { locationOccludedOpacity: opacity },
        { isLocationOccluded: () => true },
      );

      assert.equal(popup._container.style.opacity, opacity);
      assert.equal(popup._container.style.pointerEvents, "none");
      assert.equal(popup._container.style.visibility, "hidden");
      assert.equal(popup._container.classList.contains(GLOBE_POPUP_OCCLUDED_CLASS), true);
    });
  }

  for (const opacity of ["", " "]) {
    // Browsers reject " " as CSS opacity; the fake container stores it verbatim.
    it(`does not suppress interaction for blank opacity ${JSON.stringify(opacity)}`, () => {
      const maplibre = createMaplibreStub(shape);
      installGlobePopupOcclusion(maplibre);

      const popup = openPopup(
        maplibre,
        shape,
        { locationOccludedOpacity: opacity },
        { isLocationOccluded: () => true },
      );

      assert.equal(popup._container.style.opacity, opacity);
      assert.equal(popup._container.style.pointerEvents, "auto");
      assert.equal(popup._container.style.visibility, "visible");
      assert.equal(popup._container.classList.contains(GLOBE_POPUP_OCCLUDED_CLASS), false);
    });
  }

  it("does not suppress interaction for non-decimal zero opacity strings", () => {
    const maplibre = createMaplibreStub(shape);
    installGlobePopupOcclusion(maplibre);

    const popup = openPopup(
      maplibre,
      shape,
      { locationOccludedOpacity: "0e0" },
      { isLocationOccluded: () => true },
    );

    assert.equal(popup._container.style.opacity, "0e0");
    assert.equal(popup._container.style.pointerEvents, "auto");
    assert.equal(popup._container.style.visibility, "visible");
    assert.equal(popup._container.classList.contains(GLOBE_POPUP_OCCLUDED_CLASS), false);
  });

  it("calls isLocationOccluded with the transform receiver", () => {
    const maplibre = createMaplibreStub(shape);
    installGlobePopupOcclusion(maplibre);

    const popup = openPopup(maplibre, shape);
    const transform = {
      receiverMarker: "transform",
      isLocationOccluded(this: { receiverMarker: string }) {
        return this.receiverMarker === "transform";
      },
    };
    popup._map = createMap(transform, shape);
    popup._updateOpacity();

    assert.equal(popup._container.style.opacity, "0");
    assert.equal(popup._container.style.pointerEvents, "none");
  });

  it("treats a popup with no coordinate as visible", () => {
    const maplibre = createMaplibreStub(shape);
    installGlobePopupOcclusion(maplibre);

    const popup = openPopup(maplibre, shape);
    let called = false;
    popup.getLngLat = () => undefined;
    popup._map = createMap(
      {
        isLocationOccluded: () => {
          called = true;
          return true;
        },
      },
      shape,
    );
    popup._updateOpacity();

    assert.equal(called, false);
    assert.equal(popup._container.style.pointerEvents, "auto");
    assert.equal(popup._container.style.visibility, "visible");
    assert.equal(popup._container.classList.contains(GLOBE_POPUP_OCCLUDED_CLASS), false);
  });

  // MapLibre v6 ships an ESM namespace object, which is sealed: the old
  // `maplibre.Popup = GeoLibrePopup` swap threw and the map never mounted.
  it("does not assign to the maplibre namespace", () => {
    const maplibre = Object.freeze(createMaplibreStub(shape));
    const Original = maplibre.Popup;

    installGlobePopupOcclusion(maplibre);

    assert.equal(maplibre.Popup, Original);

    const popup = openPopup(maplibre, shape, undefined, { isLocationOccluded: () => true });
    assert.equal(popup._container.style.opacity, "0");
  });

  it("patches popups constructed before it runs", () => {
    const maplibre = createMaplibreStub(shape);
    const popup = new maplibre.Popup() as unknown as TestPopup;

    installGlobePopupOcclusion(maplibre);
    popup.addTo(createMap({ isLocationOccluded: () => true }, shape));

    assert.equal(popup.options.locationOccludedOpacity, 0);
    assert.equal(popup._container.style.opacity, "0");
    assert.equal(popup._container.classList.contains(GLOBE_POPUP_OCCLUDED_CLASS), true);
  });

  it("wraps a popup only once across repeated addTo calls", () => {
    const maplibre = createMaplibreStub(shape);
    installGlobePopupOcclusion(maplibre);

    const popup = openPopup(maplibre, shape);
    const wrapped = popup._updateOpacity;
    popup.addTo(createMap(neverOccluded(), shape));

    assert.equal(popup._updateOpacity, wrapped);
  });

  it("is idempotent", () => {
    const maplibre = createMaplibreStub(shape);
    installGlobePopupOcclusion(maplibre);
    const once = (maplibre.Popup.prototype as { addTo: unknown }).addTo;
    installGlobePopupOcclusion(maplibre);

    assert.equal((maplibre.Popup.prototype as { addTo: unknown }).addTo, once);
  });
});
