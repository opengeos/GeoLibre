let queue: Promise<void> = Promise.resolve();

/**
 * Run URL data loads one at a time: the startup `?data=` load and the embed
 * `addData` command share it, so two loads never run a plugin file handler
 * (and the layer bookkeeping around it) at once. A failing load does not block
 * the next.
 */
export function queueDataLoad<T>(operation: () => Promise<T>): Promise<T> {
  const next = queue.then(operation, operation);
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
