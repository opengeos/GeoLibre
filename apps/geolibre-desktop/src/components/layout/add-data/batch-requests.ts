/** A service resource request paired with the identifier shown in the picker. */
export interface NamedRequest<T> {
  key: string;
  run: () => Promise<T>;
}

export interface NamedRequestFailure {
  key: string;
  reason: unknown;
}

/**
 * Runs independent service requests together without discarding successful
 * results when one resource fails. Results retain the picker's original order.
 */
export async function settleNamedRequests<T>(requests: readonly NamedRequest<T>[]): Promise<{
  successes: { key: string; value: T }[];
  failures: NamedRequestFailure[];
}> {
  const settled: PromiseSettledResult<T>[] = new Array(requests.length);
  let nextIndex = 0;

  const runNext = async (): Promise<void> => {
    while (nextIndex < requests.length) {
      const index = nextIndex++;
      try {
        settled[index] = { status: "fulfilled", value: await requests[index].run() };
      } catch (reason) {
        settled[index] = { status: "rejected", reason };
      }
    }
  };

  // Keep pressure predictable for smaller/self-hosted feature services while
  // still overlapping the network latency of a normal multi-selection.
  const concurrency = Math.min(4, requests.length);
  await Promise.all(Array.from({ length: concurrency }, () => runNext()));
  const successes: { key: string; value: T }[] = [];
  const failures: NamedRequestFailure[] = [];

  settled.forEach((result, index) => {
    const key = requests[index].key;
    if (result.status === "fulfilled") {
      successes.push({ key, value: result.value });
    } else {
      failures.push({ key, reason: result.reason });
    }
  });

  return { successes, failures };
}
