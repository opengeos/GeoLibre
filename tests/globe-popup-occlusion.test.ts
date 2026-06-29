import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type maplibregl from "maplibre-gl";
import {
  GLOBE_POPUP_OCCLUDED_CLASS,
  installGlobePopupOcclusion,
} from "../packages/map/src/globe-popup-occlusion";

interface FakeContainer {
  classList: DOMTokenList;
  style: {
    opacity: string;
    pointerEvents: string;
    visibility: string;
  };
}

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

function createMaplibreStub(): typeof maplibregl {
  class FakePopup {
    _container = createContainer();
    _map = {
      transform: {
        isLocationOccluded(_lngLat?: unknown) {
          return false;
        },
      },
    };
    _updateOpacity: () => void;
    options: maplibregl.PopupOptions;

    constructor(options: maplibregl.PopupOptions = {}) {
      this.options = options;
      this._updateOpacity = () => {
        if (this.options.locationOccludedOpacity === undefined) return;
        if (this._map.transform.isLocationOccluded()) {
          this._container.style.opacity = `${this.options.locationOccludedOpacity}`;
        } else {
          this._container.style.opacity = "";
        }
      };
    }

    getLngLat() {
      return { lng: 0, lat: 0 };
    }
  }

  return {
    Popup: FakePopup,
  } as unknown as typeof maplibregl;
}

describe("installGlobePopupOcclusion", () => {
  it("defaults popups to hidden globe occlusion and restores interaction", () => {
    const maplibre = createMaplibreStub();
    installGlobePopupOcclusion(maplibre);

    const popup = new maplibre.Popup() as maplibregl.Popup & {
      _container: HTMLElement;
      _map: { transform: { isLocationOccluded: () => boolean } };
      _updateOpacity: () => void;
      options: maplibregl.PopupOptions;
    };
    assert.equal(popup.options.locationOccludedOpacity, 0);

    popup._map.transform.isLocationOccluded = () => true;
    popup._updateOpacity();

    assert.equal(popup._container.style.opacity, "0");
    assert.equal(popup._container.style.pointerEvents, "none");
    assert.equal(popup._container.style.visibility, "hidden");
    assert.equal(
      popup._container.classList.contains(GLOBE_POPUP_OCCLUDED_CLASS),
      true,
    );

    popup._map.transform.isLocationOccluded = () => false;
    popup._updateOpacity();

    assert.equal(popup._container.style.opacity, "");
    assert.equal(popup._container.style.pointerEvents, "auto");
    assert.equal(popup._container.style.visibility, "visible");
    assert.equal(
      popup._container.classList.contains(GLOBE_POPUP_OCCLUDED_CLASS),
      false,
    );
  });

  it("respects explicit nonzero locationOccludedOpacity values", () => {
    const maplibre = createMaplibreStub();
    installGlobePopupOcclusion(maplibre);

    const popup = new maplibre.Popup({
      locationOccludedOpacity: 0.35,
    }) as maplibregl.Popup & {
      _container: HTMLElement;
      _map: { transform: { isLocationOccluded: () => boolean } };
      _updateOpacity: () => void;
      options: maplibregl.PopupOptions;
    };

    popup._map.transform.isLocationOccluded = () => true;
    popup._updateOpacity();

    assert.equal(popup.options.locationOccludedOpacity, 0.35);
    assert.equal(popup._container.style.opacity, "0.35");
    assert.equal(popup._container.style.pointerEvents, "auto");
    assert.equal(popup._container.style.visibility, "visible");
    assert.equal(
      popup._container.classList.contains(GLOBE_POPUP_OCCLUDED_CLASS),
      false,
    );
  });

  // Real browsers normalize " 0 " to "0"; the fake container stores it verbatim.
  for (const opacity of ["0", "0.0", " 0 "]) {
    it(`suppresses interaction for zero opacity string ${opacity}`, () => {
      const maplibre = createMaplibreStub();
      installGlobePopupOcclusion(maplibre);

      const popup = new maplibre.Popup({
        locationOccludedOpacity: opacity,
      }) as maplibregl.Popup & {
        _container: HTMLElement;
        _map: { transform: { isLocationOccluded: () => boolean } };
        _updateOpacity: () => void;
      };

      popup._map.transform.isLocationOccluded = () => true;
      popup._updateOpacity();

      assert.equal(popup._container.style.opacity, opacity);
      assert.equal(popup._container.style.pointerEvents, "none");
      assert.equal(popup._container.style.visibility, "hidden");
      assert.equal(
        popup._container.classList.contains(GLOBE_POPUP_OCCLUDED_CLASS),
        true,
      );
    });
  }

  for (const opacity of ["", " "]) {
    // Browsers reject " " as CSS opacity; the fake container stores it verbatim.
    it(`does not suppress interaction for blank opacity ${JSON.stringify(
      opacity,
    )}`, () => {
      const maplibre = createMaplibreStub();
      installGlobePopupOcclusion(maplibre);

      const popup = new maplibre.Popup({
        locationOccludedOpacity: opacity,
      }) as maplibregl.Popup & {
        _container: HTMLElement;
        _map: { transform: { isLocationOccluded: () => boolean } };
        _updateOpacity: () => void;
      };

      popup._map.transform.isLocationOccluded = () => true;
      popup._updateOpacity();

      assert.equal(popup._container.style.opacity, opacity);
      assert.equal(popup._container.style.pointerEvents, "auto");
      assert.equal(popup._container.style.visibility, "visible");
      assert.equal(
        popup._container.classList.contains(GLOBE_POPUP_OCCLUDED_CLASS),
        false,
      );
    });
  }

  it("does not suppress interaction for non-decimal zero opacity strings", () => {
    const maplibre = createMaplibreStub();
    installGlobePopupOcclusion(maplibre);

    const popup = new maplibre.Popup({
      locationOccludedOpacity: "0e0",
    }) as maplibregl.Popup & {
      _container: HTMLElement;
      _map: { transform: { isLocationOccluded: () => boolean } };
      _updateOpacity: () => void;
    };

    popup._map.transform.isLocationOccluded = () => true;
    popup._updateOpacity();

    assert.equal(popup._container.style.opacity, "0e0");
    assert.equal(popup._container.style.pointerEvents, "auto");
    assert.equal(popup._container.style.visibility, "visible");
    assert.equal(
      popup._container.classList.contains(GLOBE_POPUP_OCCLUDED_CLASS),
      false,
    );
  });

  it("calls isLocationOccluded with the transform receiver", () => {
    const maplibre = createMaplibreStub();
    installGlobePopupOcclusion(maplibre);

    const popup = new maplibre.Popup() as maplibregl.Popup & {
      _container: HTMLElement;
      _map: {
        transform: {
          receiverMarker: string;
          isLocationOccluded: (lngLat?: unknown) => boolean;
        };
      };
      _updateOpacity: () => void;
    };

    popup._map.transform = {
      receiverMarker: "transform",
      isLocationOccluded(this: { receiverMarker: string }) {
        return this.receiverMarker === "transform";
      },
    };
    popup._updateOpacity();

    assert.equal(popup._container.style.opacity, "0");
    assert.equal(popup._container.style.pointerEvents, "none");
  });

  it("treats a popup with no coordinate as visible", () => {
    const maplibre = createMaplibreStub();
    installGlobePopupOcclusion(maplibre);

    const popup = new maplibre.Popup() as maplibregl.Popup & {
      _container: HTMLElement;
      _map: { transform: { isLocationOccluded: () => boolean } };
      _updateOpacity: () => void;
      getLngLat: () => undefined;
    };
    let called = false;
    popup.getLngLat = () => undefined;
    popup._map.transform.isLocationOccluded = () => {
      called = true;
      return true;
    };
    popup._updateOpacity();

    assert.equal(called, false);
    assert.equal(popup._container.style.pointerEvents, "auto");
    assert.equal(popup._container.style.visibility, "visible");
    assert.equal(
      popup._container.classList.contains(GLOBE_POPUP_OCCLUDED_CLASS),
      false,
    );
  });

  it("is idempotent", () => {
    const maplibre = createMaplibreStub();
    installGlobePopupOcclusion(maplibre);
    const once = maplibre.Popup;
    installGlobePopupOcclusion(maplibre);

    assert.equal(maplibre.Popup, once);
  });
});
