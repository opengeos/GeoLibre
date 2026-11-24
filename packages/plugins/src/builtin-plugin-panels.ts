import type { GeoLibreAppAPI } from "./types";

const noReattach: (app: GeoLibreAppAPI) => void = () => {};
const unavailablePanel: (app: GeoLibreAppAPI) => void = () => {
  throw new Error("Plugin panel implementation has not loaded.");
};
const panelRuntime = () => ({
  reattach: noReattach,
  open: unavailablePanel,
  close: unavailablePanel,
});

/** Shared visibility survives either catalog loading or direct SDK imports. */
function createPanelStore<Runtime>(runtime: Runtime) {
  let visible = false;
  const listeners = new Set<() => void>();
  return {
    runtime,
    getSnapshot: (): boolean => visible,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setVisible: (next: boolean): void => {
      if (next === visible) return;
      visible = next;
      for (const listener of listeners) listener();
    },
  };
}

export const sunPanelStore = createPanelStore(panelRuntime());
export const routeAnimationPanelStore = createPanelStore(panelRuntime());
export const flightSimulatorPanelStore = createPanelStore({
  ...panelRuntime(),
  isFlying: (): boolean => false,
});
export const godsEyeViewRuntime = { reattach: noReattach };
