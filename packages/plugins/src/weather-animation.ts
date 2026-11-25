import type { WeatherAnimationState, WeatherLayerController } from "./plugins/weather-layer";

type AnimationController = Pick<
  WeatherLayerController,
  "getState" | "setFrame" | "togglePlaying" | "subscribe"
>;

/** Connect menu observers when a weather provider is imported by any caller. */
function createAnimationBridge() {
  let controller: AnimationController | undefined;
  let disconnect: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  return {
    provide: (next: AnimationController): void => {
      if (controller === next) return;
      disconnect?.();
      controller = next;
      disconnect = next.subscribe(notify);
      notify();
    },
    getState: (): WeatherAnimationState =>
      controller?.getState() ?? { labels: [], index: 0, playing: false, active: false },
    setFrame: (index: number): void => controller?.setFrame(index),
    togglePlaying: (): void => controller?.togglePlaying(),
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const cloudsAnimation = createAnimationBridge();
export const precipitationAnimation = createAnimationBridge();
