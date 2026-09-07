import {
  IDENTIFY_ALL_LAYERS_ID,
  isPopupClickEnabled,
  isPopupHoverEnabled,
  useAppStore,
} from "@geolibre/core";
import type { Cartesian2, CesiumWidget } from "@cesium/engine";
import type { CesiumEngine } from "./cesium-engine";
import { createHoverTooltipElement, createIdentifyPopupElement } from "./feature-popup";

/** Globe input uses the same popup field, expression and sanitization path as 2D. */
export function installCesiumInteractions(
  C: typeof import("@cesium/engine"),
  viewer: CesiumWidget,
  engine: CesiumEngine,
  closeLabel: () => string = () => "Close",
): () => void {
  const handler = new C.ScreenSpaceEventHandler(viewer.canvas);
  const host = viewer.canvas.parentElement!;
  let popup: HTMLElement | null = null;
  let hover: HTMLElement | null = null;
  let pending: Cartesian2 | null = null;
  // Where the cursor last rested over the canvas. Outlives `pending`, which a
  // camera move clears, so the readout can be restored once the move settles.
  let lastPointer: Cartesian2 | null = null;
  let frame = 0;
  let moving = false;
  const publishPointer = (point: Cartesian2 | null) => {
    const state = useAppStore.getState();
    const pointer = point ? engine.readPointerAtScreen(point) : null;
    state.setPointerCoords(pointer?.coordinates ?? null);
    state.setPointerElevation(
      state.preferences.map.showPointerElevation ? (pointer?.elevation ?? null) : null,
    );
    return state;
  };
  const clearHover = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    pending = null;
    hover?.remove();
    hover = null;
  };
  const clearPopup = () => {
    popup?.remove();
    popup = null;
  };
  const place = (content: HTMLElement, point: Cartesian2, isHover: boolean) => {
    const box = document.createElement("div");
    box.className = isHover ? "geolibre-hover-tooltip" : "geolibre-identify-popup";
    Object.assign(box.style, {
      position: "absolute",
      zIndex: "10",
      maxWidth: "min(520px, 90%)",
      maxHeight: "60%",
      overflow: "auto",
      padding: "10px",
      borderRadius: "6px",
      background: "hsl(var(--background))",
      color: "hsl(var(--foreground))",
      boxShadow: "0 2px 12px #0005",
      pointerEvents: isHover ? "none" : "auto",
    });
    if (!isHover) {
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "×";
      close.setAttribute("aria-label", closeLabel());
      close.className =
        "absolute end-1 top-1 rounded px-1 text-lg hover:bg-muted focus-visible:outline";
      close.addEventListener("click", clearPopup);
      box.append(close);
    }
    box.append(content);
    host.append(box);
    box.style.left = `${Math.max(0, Math.min(point.x + 12, host.clientWidth - box.offsetWidth))}px`;
    box.style.top = `${Math.max(0, Math.min(point.y + 12, host.clientHeight - box.offsetHeight))}px`;
    return box;
  };
  handler.setInputAction((event: { endPosition: Cartesian2 }) => {
    pending = C.Cartesian2.clone(event.endPosition);
    lastPointer = pending;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const point = pending;
      const state = publishPointer(point);
      hover?.remove();
      hover = null;
      if (!point || moving || state.identifyLayerId) return;
      for (const hit of engine.identifyAtScreen(point)) {
        const layer = state.layers.find((item) => item.id === hit.layerId);
        if (!layer || !isPopupHoverEnabled(layer.popup)) continue;
        const content = createHoverTooltipElement(layer.name, hit.properties, {
          popup: layer.popup,
          fieldVisibility: layer.fieldVisibility,
          feature: hit.geometry
            ? { type: "Feature", properties: hit.properties, geometry: hit.geometry }
            : null,
          zoom: engine.readView().zoom,
        });
        if (content) hover = place(content, point, true);
        break;
      }
    });
  }, C.ScreenSpaceEventType.MOUSE_MOVE);
  handler.setInputAction((event: { position: Cartesian2 }) => {
    clearHover();
    clearPopup();
    const state = useAppStore.getState();
    const target = state.identifyLayerId;
    if (!target) return;
    const hits = engine.identifyAtScreen(
      event.position,
      target && target !== IDENTIFY_ALL_LAYERS_ID ? target : undefined,
    );
    const content = document.createElement("div");
    let selected = false;
    for (const hit of hits) {
      const layer = state.layers.find((item) => item.id === hit.layerId);
      if (!layer || !isPopupClickEnabled(layer.popup)) continue;
      content.append(
        createIdentifyPopupElement(layer.name, hit.properties, hit.featureId ?? undefined, {
          popup: layer.popup,
          fieldVisibility: layer.fieldVisibility,
          feature: hit.geometry
            ? { type: "Feature", properties: hit.properties, geometry: hit.geometry }
            : null,
          zoom: engine.readView().zoom,
        }),
      );
      if (!selected) {
        selected = true;
        state.selectLayer(layer.id);
        state.selectFeature(hit.featureId);
      }
      if (target !== IDENTIFY_ALL_LAYERS_ID) break;
    }
    if (content.childElementCount) popup = place(content, event.position, false);
  }, C.ScreenSpaceEventType.LEFT_CLICK);
  const selection = () => {
    const state = useAppStore.getState();
    engine.highlightFeature(
      state.layers.find((layer) => layer.id === state.selectedLayerId),
      state.selectedFeatureIds.length ? state.selectedFeatureIds : state.selectedFeatureId,
    );
  };
  const unsubscribe = useAppStore.subscribe((state, prev) => {
    if (state.preferences.map.showPointerElevation !== prev.preferences.map.showPointerElevation) {
      state.setPointerElevation(
        state.preferences.map.showPointerElevation && lastPointer
          ? (engine.readPointerAtScreen(lastPointer)?.elevation ?? null)
          : null,
      );
    }
    if (
      state.selectedLayerId !== prev.selectedLayerId ||
      state.selectedFeatureIds !== prev.selectedFeatureIds ||
      state.selectedFeatureId !== prev.selectedFeatureId
    )
      selection();
    if (
      state.identifyLayerId !== prev.identifyLayerId ||
      state.layers !== prev.layers ||
      state.layerGroups !== prev.layerGroups
    ) {
      clearHover();
      clearPopup();
    }
  });
  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      clearHover();
      clearPopup();
    }
  };
  const leave = () => {
    clearHover();
    lastPointer = null;
    useAppStore.getState().setPointerCoords(null);
  };
  viewer.canvas.addEventListener("mouseleave", leave);
  window.addEventListener("keydown", escape);
  const moveStart = () => {
    moving = true;
    clearHover();
    clearPopup();
    useAppStore.getState().setPointerCoords(null);
  };
  const moveEnd = () => {
    moving = false;
    // Home, fullscreen, a scene-mode switch or drag momentum move the camera
    // without a pointer event, so re-read the resting cursor instead of
    // leaving the readout blank until the mouse moves again.
    if (lastPointer) publishPointer(lastPointer);
  };
  viewer.camera.moveStart.addEventListener(moveStart);
  viewer.camera.moveEnd.addEventListener(moveEnd);

  selection();
  return () => {
    unsubscribe();
    handler.destroy();
    leave();
    clearPopup();
    viewer.canvas.removeEventListener("mouseleave", leave);
    window.removeEventListener("keydown", escape);
    viewer.camera.moveStart.removeEventListener(moveStart);
    viewer.camera.moveEnd.removeEventListener(moveEnd);
  };
}
