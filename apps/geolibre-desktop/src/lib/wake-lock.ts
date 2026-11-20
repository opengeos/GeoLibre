import { useEffect, useState } from "react";

export interface WakeLockSentinelLike {
  released?: boolean;
  release(): Promise<void>;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

export interface WakeLockNavigatorLike {
  wakeLock?: {
    request(type: "screen"): Promise<WakeLockSentinelLike>;
  };
}

export interface WakeLockController {
  readonly supported: boolean;
  acquire(): Promise<boolean>;
  release(): Promise<void>;
  dispose(): void;
}

/**
 * Feature-detected Screen Wake Lock controller for outdoor GPS tracking and
 * field collection (GeoLibre#3537 Phase 4). Automatically re-acquires the lock
 * when the page returns to the foreground after being backgrounded.
 */
export function createWakeLockController(options?: {
  navigator?: WakeLockNavigatorLike;
  document?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  onChange?: (active: boolean) => void;
}): WakeLockController {
  const nav =
    options?.navigator ??
    (typeof navigator !== "undefined" ? (navigator as WakeLockNavigatorLike) : undefined);
  const doc = options?.document ?? (typeof document !== "undefined" ? document : undefined);
  const supported = Boolean(nav?.wakeLock && typeof nav.wakeLock.request === "function");

  let sentinel: WakeLockSentinelLike | null = null;
  let pendingRequest: Promise<boolean> | null = null;
  let wanted = false;
  let disposed = false;

  const notify = (active: boolean) => {
    options?.onChange?.(active);
  };

  const handleSentinelRelease = () => {
    sentinel = null;
    if (!disposed) notify(false);
  };

  const requestLock = (): Promise<boolean> => {
    if (!supported || disposed || !nav?.wakeLock) return Promise.resolve(false);
    if (sentinel && !sentinel.released) return Promise.resolve(true);
    if (pendingRequest) return pendingRequest;
    const req = (async () => {
      try {
        const next = await nav.wakeLock!.request("screen");
        if (disposed || !wanted) {
          await next.release().catch(() => {});
          return false;
        }
        if (sentinel && sentinel !== next) {
          sentinel.removeEventListener?.("release", handleSentinelRelease);
          await sentinel.release().catch(() => {});
        }
        sentinel = next;
        next.addEventListener?.("release", handleSentinelRelease);
        notify(true);
        return true;
      } catch {
        if (!disposed) notify(false);
        return false;
      }
    })();
    pendingRequest = req;
    void req.finally(() => {
      if (pendingRequest === req) pendingRequest = null;
    });
    return req;
  };

  const handleVisibilityChange = () => {
    if (wanted && !disposed && doc?.visibilityState === "visible") {
      void requestLock();
    }
  };

  doc?.addEventListener("visibilitychange", handleVisibilityChange);

  return {
    supported,
    async acquire() {
      wanted = true;
      return requestLock();
    },
    async release() {
      wanted = false;
      const current = sentinel;
      sentinel = null;
      if (current) {
        current.removeEventListener?.("release", handleSentinelRelease);
        await current.release().catch(() => {});
      }
      notify(false);
    },
    dispose() {
      disposed = true;
      wanted = false;
      doc?.removeEventListener("visibilitychange", handleVisibilityChange);
      const current = sentinel;
      sentinel = null;
      if (current) {
        current.removeEventListener?.("release", handleSentinelRelease);
        void current.release().catch(() => {});
      }
    },
  };
}

/**
 * Keep the device screen awake while `enabled` is true (e.g. during active GPS
 * track recording or outdoor field collection).
 */
export function useScreenWakeLock(enabled: boolean): {
  supported: boolean;
  active: boolean;
} {
  const [active, setActive] = useState(false);
  const supported =
    typeof navigator !== "undefined" &&
    Boolean((navigator as WakeLockNavigatorLike).wakeLock?.request);

  useEffect(() => {
    if (!enabled || !supported) {
      setActive(false);
      return;
    }
    const controller = createWakeLockController({ onChange: setActive });
    void controller.acquire();
    return () => {
      controller.dispose();
      setActive(false);
    };
  }, [enabled, supported]);

  return { supported, active };
}
