import { useEffect, useLayoutEffect, useRef, type Dispatch } from "react";
import { useTranslation } from "react-i18next";
import type { PrintLayoutConfig } from "@geolibre/core";
import type {
  LayoutElementBox,
  LayoutElementBoxes,
  LayoutElementId,
  LayoutMovableElement,
} from "../../../lib/print-layout";
import {
  adjustFrameBox,
  movedOffset,
  rectToFrameBox,
  resizedOffset,
  type FrameBox,
} from "../../../lib/print-layout-cartography";
import type { PrintLayoutAction } from "./state";

/** What the preview last drew: the element boxes and the canvas geometry. */
export interface ArrangeFrame {
  boxes: LayoutElementBoxes;
  /** Page size in canvas pixels (the space `boxes` is in). */
  pageW: number;
  pageH: number;
  /** The canvas's on-screen size in CSS pixels. */
  cssW: number;
  cssH: number;
}

/** Frames first, so furniture drawn over the map stays grabbable on top. */
const ORDER: readonly LayoutElementId[] = [
  "map",
  "inset",
  "title",
  "footer",
  "legend",
  "scaleBar",
  "northArrow",
];

interface Gesture {
  id: LayoutElementId;
  mode: "move" | "resize";
  x: number;
  y: number;
  entry: LayoutElementBox;
  layout: PrintLayoutConfig;
}

interface ArrangeOverlayProps {
  frame: ArrangeFrame;
  layout: PrintLayoutConfig;
  dispatch: Dispatch<PrintLayoutAction>;
}

/**
 * Drag and resize handles over the preview canvas (GH #3530). Moving a map
 * frame stores its page box; moving furniture stores an offset from its
 * automatic place. Both are page fractions, so what is arranged on the preview
 * lands in the same place in every export.
 */
export function ArrangeOverlay({ frame, layout, dispatch }: ArrangeOverlayProps) {
  const { t } = useTranslation();
  const gestureRef = useRef<Gesture | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<{ gesture: Gesture; dx: number; dy: number } | null>(null);
  const applyRef = useRef<((gesture: Gesture, dx: number, dy: number) => void) | null>(null);
  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );
  const { boxes, pageW, pageH, cssW, cssH } = frame;
  const valid = pageW > 0 && pageH > 0 && cssW > 0 && cssH > 0;
  const toCss = cssW / pageW;

  /** Apply a drag of (`dxCss`, `dyCss`) CSS pixels to `gesture`'s start state. */
  const apply = (gesture: Gesture, dxCss: number, dyCss: number) => {
    if (!valid) return;
    const { id, mode, entry, layout: start } = gesture;
    if (id === "map" || id === "inset") {
      const field = id === "map" ? "mapFrameBox" : "insetBox";
      const from: FrameBox = start[field] ?? rectToFrameBox(entry.box, pageW, pageH);
      const next = adjustFrameBox(from, mode, dxCss / cssW, dyCss / cssH);
      dispatch({ type: "setLayout", patch: { [field]: next } });
      return;
    }
    if (!entry.natural || !entry.anchor) return;
    const dxPage = dxCss / toCss;
    const dyPage = dyCss / toCss;
    const offset = start.elementOffsets[id];
    const next =
      mode === "move"
        ? movedOffset(offset, dxPage, dyPage, pageW, pageH)
        : resizedOffset(entry.natural, entry.anchor, offset, dxPage, dyPage, pageW, pageH);
    dispatch({
      type: "setLayout",
      patch: { elementOffsets: { ...start.elementOffsets, [id as LayoutMovableElement]: next } },
    });
  };
  useLayoutEffect(() => {
    applyRef.current = apply;
  });
  if (!valid) return null;
  const flush = () => {
    rafRef.current = null;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) applyRef.current?.(pending.gesture, pending.dx, pending.dy);
  };

  const begin = (
    e: React.PointerEvent<HTMLElement>,
    id: LayoutElementId,
    entry: LayoutElementBox,
    mode: "move" | "resize",
  ) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    gestureRef.current = { id, mode, x: e.clientX, y: e.clientY, entry, layout };
  };
  const move = (e: React.PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    pendingRef.current = { gesture, dx: e.clientX - gesture.x, dy: e.clientY - gesture.y };
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(flush);
  };
  const end = (e: React.PointerEvent<HTMLElement>) => {
    if (!gestureRef.current) return;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    flush();
    gestureRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };
  const nudge = (
    e: React.KeyboardEvent<HTMLElement>,
    id: LayoutElementId,
    entry: LayoutElementBox,
  ) => {
    const step = (e.shiftKey ? 10 : 2) * (cssW / 200);
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = delta[e.key];
    if (!d) return;
    e.preventDefault();
    // Alt+arrows resize instead of moving.
    apply({ id, mode: e.altKey ? "resize" : "move", x: 0, y: 0, entry, layout }, d[0], d[1]);
  };

  return (
    <div className="pointer-events-none absolute inset-0" data-testid="print-arrange-overlay">
      {ORDER.map((id) => {
        const entry = boxes[id];
        if (!entry) return null;
        const { box } = entry;
        const name = t(`printLayout.arrange.element.${id}`);
        const isFrame = id === "map" || id === "inset";
        return (
          <div
            key={id}
            role="button"
            tabIndex={0}
            aria-label={name}
            title={name}
            data-element={id}
            className={`pointer-events-auto absolute cursor-move touch-none border-2 border-dashed focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              isFrame ? "border-sky-500/80" : "border-primary/90 bg-primary/5"
            }`}
            // Page geometry is not mirrored for right-to-left locales: the
            // canvas is a picture of the page, so these offsets stay physical.
            style={{
              left: box.x * toCss,
              top: box.y * toCss,
              width: Math.max(8, box.w * toCss),
              height: Math.max(8, box.h * toCss),
            }}
            onPointerDown={(e) => begin(e, id, entry, "move")}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onKeyDown={(e) => nudge(e, id, entry)}
          >
            <span
              role="presentation"
              title={t("printLayout.arrange.resizeHandle", { name })}
              className="absolute h-3 w-3 cursor-nwse-resize rounded-sm border border-background bg-primary"
              style={{ right: -6, bottom: -6 }}
              onPointerDown={(e) => begin(e, id, entry, "resize")}
            />
          </div>
        );
      })}
    </div>
  );
}
