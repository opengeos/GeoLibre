/**
 * A one-way flag with a bounded wait: `wait()` resolves once every part has
 * been settled with `settle(part)`, or after `timeoutMs`, whichever comes
 * first. Used to hold work until startup has finished without letting a stuck
 * startup block it forever.
 *
 * @param timeoutMs - The longest a single `wait()` may last.
 * @param parts - The names that must all settle; one unnamed part by default.
 */
export function createSettleGate(timeoutMs: number, parts: string[] = [""]) {
  const pending = new Set(parts);
  const waiters = new Set<() => void>();
  return {
    settle(part = ""): void {
      pending.delete(part);
      if (pending.size > 0) return;
      for (const resolve of [...waiters]) resolve();
    },
    wait(): Promise<void> {
      if (pending.size === 0) return Promise.resolve();
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
