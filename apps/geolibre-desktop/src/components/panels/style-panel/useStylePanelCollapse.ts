import { useCallback, useEffect, useRef, useState } from "react";

interface StylePanelCollapseOptions {
  openRequest: number;
  autoCollapse: boolean;
  controlledCollapsed: boolean | undefined;
  onCollapsedChange: ((collapsed: boolean) => void) | undefined;
}

/**
 * The Style panel's expand/collapse state: local by default, owned by the
 * parent in the shared right-sidebar (controlled) mode, and driven by explicit
 * open requests and the `autoCollapse` flag.
 *
 * @param options - The panel's `openRequest`, `autoCollapse`, `collapsed` and
 *   `onCollapsedChange` props.
 * @returns Whether the panel is collapsed and a setter routed to its owner.
 */
export function useStylePanelCollapse({
  openRequest,
  autoCollapse,
  controlledCollapsed,
  onCollapsedChange,
}: StylePanelCollapseOptions) {
  // Style starts on its rail on every platform and remains there until the
  // user explicitly expands it.
  const [internalCollapsed, setInternalCollapsed] = useState(true);
  // In the shared right-sidebar mode the parent owns collapse (controlled);
  // otherwise the panel manages it locally. `setIsCollapsed` routes to whichever
  // owner applies so every existing call site keeps working.
  const isControlled = controlledCollapsed !== undefined;
  const isCollapsed = isControlled ? controlledCollapsed : internalCollapsed;
  const setIsCollapsed = useCallback(
    (value: boolean) => {
      if (isControlled) onCollapsedChange?.(value);
      else setInternalCollapsed(value);
    },
    [isControlled, onCollapsedChange],
  );
  // An explicit request (Layers → "Open Style panel") expands the panel from its
  // rail. Skipped while `autoCollapse` holds it closed (the notebook or a
  // story-map presentation owns the workspace), so a request made there cannot
  // pop Style back open over them: the `autoCollapse` effect below acts only on
  // transitions, so an expand that slipped through would stick until the
  // notebook was closed and reopened. The request is still consumed so it does
  // not fire later.
  const previousOpenRequest = useRef(openRequest);
  useEffect(() => {
    if (openRequest === previousOpenRequest.current) return;
    previousOpenRequest.current = openRequest;
    if (!autoCollapse) setIsCollapsed(false);
  }, [autoCollapse, openRequest, setIsCollapsed]);
  // Collapse to the rail when `autoCollapse` flips on (e.g. the notebook opens),
  // and restore the prior expand/collapse state when it flips back off (notebook
  // closes). Both act only on the transition so the user can still toggle the
  // panel manually while `autoCollapse` stays on. `isCollapsed` is in the deps
  // only to keep the captured value fresh; the guards make pure `isCollapsed`
  // changes a no-op while `autoCollapse` is stable. The ref starts as null (not
  // `autoCollapse`) so a mount with `autoCollapse` already true reads as a
  // null→true transition and still collapses. Skipped entirely in controlled
  // mode, where the parent (shared rail) owns collapse and never passes
  // `autoCollapse`.
  const prevAutoCollapse = useRef<boolean | null>(null);
  const collapsedBeforeAuto = useRef(isCollapsed);
  useEffect(() => {
    if (isControlled) return;
    const wasAuto = prevAutoCollapse.current;
    prevAutoCollapse.current = autoCollapse;
    if (autoCollapse && !wasAuto) {
      collapsedBeforeAuto.current = internalCollapsed;
      setInternalCollapsed(true);
    } else if (!autoCollapse && wasAuto) {
      setInternalCollapsed(collapsedBeforeAuto.current);
    }
  }, [autoCollapse, internalCollapsed, isControlled]);
  return { isCollapsed, setIsCollapsed };
}
