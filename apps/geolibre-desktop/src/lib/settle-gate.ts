/**
 * A one-way flag with a bounded wait: `wait()` resolves once `settle()` has
 * been called, or after `timeoutMs`, whichever comes first. Used to hold work
 * until startup has finished without letting a stuck startup block it forever.
 *
 * @param timeoutMs - The longest a single `wait()` may last.
 */
export function createSettleGate(timeoutMs: number) {
  let settled = false;
  const waiters = new Set<() => void>();
  return {
    settle(): void {
      settled = true;
      for (const resolve of [...waiters]) resolve();
    },
    wait(): Promise<void> {
      if (settled) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, timeoutMs);
        waiters.add(done);
      });
    },
  };
}
