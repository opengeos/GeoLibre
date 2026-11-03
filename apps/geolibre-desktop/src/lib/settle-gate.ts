/**
 * A bounded wait for startup work. `wait()` resolves once every part has been
 * settled with `settle(part)` and the optional `after` work has finished, or
 * when one absolute deadline of `timeoutMs` (counted from the first `wait()`)
 * passes, whichever comes first. Either way the gate then stays open for good,
 * so a stuck startup delays the first caller by at most the deadline and later
 * callers not at all.
 *
 * @param timeoutMs - The deadline, shared by every caller.
 * @param parts - The names that must all settle; one unnamed part by default.
 * @param after - Work to await once every part has settled; it is bounded by
 *   the same deadline.
 */
export function createSettleGate(
  timeoutMs: number,
  parts: string[] = [""],
  after?: () => Promise<unknown>,
) {
  const pending = new Set(parts);
  let partsSettled: () => void = () => undefined;
  const allPartsSettled = new Promise<void>((resolve) => {
    partsSettled = resolve;
  });
  if (pending.size === 0) partsSettled();
  let open = false;
  let waiting: Promise<void> | undefined;
  return {
    settle(part = ""): void {
      pending.delete(part);
      if (pending.size === 0) partsSettled();
    },
    wait(): Promise<void> {
      if (open) return Promise.resolve();
      waiting ??= new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          open = true;
          resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        void allPartsSettled.then(() => after?.()).then(finish, finish);
      });
      return waiting;
    },
  };
}

/**
 * Whether startup plugin activation has finished for the project being shown:
 * the `?url=` project (if any) has loaded, and the plugin restore has run for
 * that project's generation rather than for the empty one before it.
 */
export function startupActivationSettled(state: {
  projectUrlSettled: boolean;
  restoredGeneration: number | null;
  projectGeneration: number;
}): boolean {
  return state.projectUrlSettled && state.restoredGeneration === state.projectGeneration;
}

/**
 * A flag that, once true, stays true. For a "has finished" signal that a state
 * machine may report as false again later (a loader going from `loaded` back to
 * `idle`), which must not un-settle what already settled.
 */
export function createLatch(): (value: boolean) => boolean {
  let latched = false;
  return (value) => (latched ||= value);
}

/**
 * Whether the `?plugin=` link has activated everything it asked for: its names
 * are resolved, no registry plugin waits for a trust decision, and none is
 * installing or activating after one.
 */
export function deepLinkSettled(state: {
  linkResolved: boolean;
  pending: number;
  awaiting: number;
  activating: number;
}): boolean {
  return (
    state.linkResolved && state.pending === 0 && state.awaiting === 0 && state.activating === 0
  );
}
