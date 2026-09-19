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
  const settled = await Promise.allSettled(requests.map((request) => request.run()));
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
