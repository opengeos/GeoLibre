import {
  effectiveLayerRenderState,
  IDENTIFY_ALL_LAYERS_ID,
  identifyAllIncludes,
  isPopupClickEnabled,
  isPopupHoverEnabled,
  resolvePopupMaxWidth,
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
  // Layers whose features the open click popup shows, so hiding one closes it.
  let popupLayerIds: string[] = [];
  let popupResizeObserver: ResizeObserver | null = null;
  let hover: HTMLElement | null = null;
  // Layer the hover tooltip shows, so hiding it clears the tooltip too.
  let hoverLayerId: string | null = null;
  let pending: Cartesian2 | null = null;
  // Where the cursor last rested over the canvas. Outlives `pending`, which a
  // camera move clears, so the readout can be restored once the move settles.
  let lastPointer: Cartesian2 | null = null;
  let frame = 0;
  let moving = false;
  const setIdentifyCursor = (active: boolean) => {
    viewer.canvas.style.cursor = active ? "crosshair" : "";
  };
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
    hoverLayerId = null;
  };
  const clearPopup = () => {
    popupResizeObserver?.disconnect();
    popupResizeObserver = null;
    popup?.remove();
    popup = null;
    popupLayerIds = [];
  };
  const place = (
    content: HTMLElement,
    point: Cartesian2,
    isHover: boolean,
    configuredMaxWidth?: number,
  ) => {
    const hasImage = !isHover && content.querySelector(".geolibre-popup-image") !== null;
    const box = document.createElement("div");
    box.className = isHover ? "geolibre-hover-tooltip" : "geolibre-identify-popup";
    if (hasImage) box.classList.add("geolibre-identify-image-popup");
    // The globe's popup is this box, not a MapLibre shell, so an author's
    // `maxWidth` has to widen it here too — the root inside it can only ever
    // use the width the box gives it. It reaches `width` only for a box
    // carrying a picture, the same split `applyPopupWidth` makes in 2D: a
    // text-only popup keeps shrinking to its content with the author's value
    // as its ceiling, rather than padding every short feature out to it.
    const configuredWidth =
      configuredMaxWidth === undefined
        ? undefined
        : `min(${configuredMaxWidth}px, calc(100% - 24px))`;
    Object.assign(box.style, {
      position: "absolute",
      zIndex: "10",
      width: hasImage ? (configuredWidth ?? "min(420px, calc(100% - 24px))") : "auto",
      maxWidth: configuredWidth ?? (hasImage ? "min(900px, calc(100% - 24px))" : "min(280px, 80%)"),
      maxHeight: hasImage ? "calc(100% - 24px)" : "60%",
      overflow: "auto",
      resize: hasImage ? "both" : "none",
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
    const gap = 12;
    const positionBox = () => {
      const right = point.x + gap;
      const below = point.y + gap;
      box.style.left = `${
        right + box.offsetWidth <= host.clientWidth
          ? right
          : Math.max(0, point.x - gap - box.offsetWidth)
      }px`;
      box.style.top = `${
        below + box.offsetHeight <= host.clientHeight
          ? below
          : Math.max(0, point.y - gap - box.offsetHeight)
      }px`;
    };
    // Which side of the cursor the box sits on is a placement-time decision.
    // Re-deciding it while the user drags the native resize handle would flip
    // the box to the other side of the pointer mid-drag, so a resize only pulls
    // the box back inside the host without moving its anchored edges.
    const clampBox = () => {
      const left = Number.parseFloat(box.style.left) || 0;
      const top = Number.parseFloat(box.style.top) || 0;
      box.style.left = `${Math.max(0, Math.min(left, host.clientWidth - box.offsetWidth))}px`;
      box.style.top = `${Math.max(0, Math.min(top, host.clientHeight - box.offsetHeight))}px`;
    };
    positionBox();
    // Lazy popup images have no intrinsic height during the first placement.
    // Reposition on the next layout even when the browser already cached the
    // image, and again after an uncached image loads.
    requestAnimationFrame(positionBox);
    for (const image of box.querySelectorAll("img")) {
      if (!image.complete) image.addEventListener("load", positionBox, { once: true });
    }
    if (hasImage && typeof ResizeObserver !== "undefined") {
      popupResizeObserver?.disconnect();
      popupResizeObserver = new ResizeObserver(clampBox);
      popupResizeObserver.observe(box);
    }
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
      hoverLayerId = null;
      if (!point || moving || state.identifyLayerId) return;
      if (!state.layers.some((layer) => isPopupHoverEnabled(layer.popup))) return;
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
        if (content) {
          hover = place(content, point, true, resolvePopupMaxWidth(layer.popup));
          hoverLayerId = layer.id;
        }
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
    // Several layers can answer one click on the globe, so the box takes the
    // widest width any of them asked for.
    let widest: number | undefined;
    for (const hit of hits) {
      const layer = state.layers.find((item) => item.id === hit.layerId);
      if (!layer || !isPopupClickEnabled(layer.popup)) continue;
      if (
        target === IDENTIFY_ALL_LAYERS_ID &&
        !identifyAllIncludes(layer.id, state.identifyLayerIds)
      )
        continue;
      const configured = resolvePopupMaxWidth(layer.popup);
      if (configured !== undefined) widest = Math.max(widest ?? configured, configured);
      popupLayerIds.push(layer.id);
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
    if (content.childElementCount) popup = place(content, event.position, false, widest);
    else state.selectFeature(null);
  }, C.ScreenSpaceEventType.LEFT_CLICK);
  // Highlight only: CesiumCanvas owns the zoom-to-selection fit, including
  // suppressing it when an Identify restore reselects a feature.
  const selection = () => {
    const state = useAppStore.getState();
    engine.highlightFeature(
      state.layers.find((layer) => layer.id === state.selectedLayerId),
      state.selectedFeatureIds.length ? state.selectedFeatureIds : state.selectedFeatureId,
    );
  };
  const layerHidden = (state: ReturnType<typeof useAppStore.getState>, id: string) => {
    const layer = state.layers.find((item) => item.id === id);
    return !layer || !effectiveLayerRenderState(layer, state.layerGroups).visible;
  };
  const popupLayerHidden = (state: ReturnType<typeof useAppStore.getState>) =>
    popupLayerIds.some((id) => layerHidden(state, id));
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
      ((state.layers !== prev.layers || state.layerGroups !== prev.layerGroups) &&
        popupLayerHidden(state)) ||
      (state.layers !== prev.layers &&
        state.identifyLayerId &&
        state.identifyLayerId !== IDENTIFY_ALL_LAYERS_ID &&
        !state.layers.some((layer) => layer.id === state.identifyLayerId))
    ) {
      clearHover();
      clearPopup();
    } else if (
      hoverLayerId &&
      (state.layers !== prev.layers || state.layerGroups !== prev.layerGroups) &&
      layerHidden(state, hoverLayerId)
    ) {
      clearHover();
    }
    if (state.identifyLayerId !== prev.identifyLayerId) {
      setIdentifyCursor(Boolean(state.identifyLayerId));
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
  setIdentifyCursor(Boolean(useAppStore.getState().identifyLayerId));
  return () => {
    unsubscribe();
    handler.destroy();
    leave();
    clearPopup();
    setIdentifyCursor(false);
    viewer.canvas.removeEventListener("mouseleave", leave);
    window.removeEventListener("keydown", escape);
    viewer.camera.moveStart.removeEventListener(moveStart);
    viewer.camera.moveEnd.removeEventListener(moveEnd);
  };
}
