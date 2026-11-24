/** Require the platform limiter before allowing a new collaboration session. */
export async function sessionCreationRateStatus(
  limiter: RateLimit | undefined,
  key: string,
): Promise<429 | 503 | null> {
  if (!limiter) {
    console.warn(
      JSON.stringify({ event: "collab_rate_limit_unavailable", reason: "binding_missing" }),
    );
    return 503;
  }
  try {
    return (await limiter.limit({ key })).success ? null : 429;
  } catch {
    // Existing sessions stay usable, but a platform outage must not reset
    // session-creation budgets independently in each Worker isolate.
    console.warn(
      JSON.stringify({ event: "collab_rate_limit_unavailable", reason: "binding_error" }),
    );
    return 503;
  }
}
