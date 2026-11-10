/** Delayed actions kept apart by key, so scheduling one never cancels another key's. */
export interface KeyedDebounce {
  /** Runs `action` after the delay, replacing any action still waiting under the same key. */
  schedule(key: string, action: () => void): void;
  /** Whether an action is still waiting under the key. */
  pending(key: string): boolean;
}

/**
 * Debounces per key. Editing one layer's style restarts only that layer's wait; an edit to
 * another layer in the meantime leaves it alone.
 *
 * @param delayMs - How long an action waits for a newer one under the same key.
 * @returns The scheduler.
 */
export function createKeyedDebounce(delayMs: number): KeyedDebounce {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    schedule(key, action) {
      clearTimeout(timers.get(key));
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          action();
        }, delayMs),
      );
    },
    pending: (key) => timers.has(key),
  };
}
