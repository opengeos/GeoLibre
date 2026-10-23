import type { ImageryProvider } from "@cesium/engine";

/**
 * Per-layer tile health for a Cesium imagery provider, so a layer whose tiles
 * all fail (a wrong URL template, a rejected API key) can be reported the way
 * the 2D engines report theirs instead of the globe silently drawing nothing.
 *
 * Cesium has no per-tile success event and loads most tile images through an
 * `<img>` element, whose HTTP status is invisible. So this counts both sides
 * itself: successes by wrapping the provider's `requestImage`, failures from
 * the provider's `errorEvent` (where `ImageryLayer` reports every rejected
 * tile). The status is passed on when Cesium saw one (a blob/XHR fetch), and
 * left undefined otherwise; deciding whether a run of failures is worth telling
 * the user about is the app's call, from the tallies.
 */

/** One failed tile, with the provider's tallies so far. */
export interface ImageryTileFailure {
  /** The tile request's HTTP status, when Cesium could see it. */
  status?: number;
  /** Cesium's description of the failure. */
  message: string;
  /** Tiles that loaded since the provider was attached. */
  loaded: number;
  /** Tiles that failed since the provider was attached, this one included. */
  failed: number;
}

/**
 * The most failures one provider reports. A sparse tile set answers "not
 * found" for every empty tile, and Cesium cannot tell that from a broken URL,
 * so an unbounded report would flood Diagnostics while panning; the app only
 * needs the first few to decide.
 */
export const MAX_REPORTED_TILE_FAILURES = 32;

/** The HTTP status carried by whatever Cesium rejected a tile with, if any. */
function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as { statusCode?: unknown; status?: unknown };
  const status = record.statusCode ?? record.status;
  return typeof status === "number" && Number.isFinite(status) && status > 0 ? status : undefined;
}

/**
 * Starts counting a provider's tile loads and failures.
 *
 * @param provider - The imagery provider, before or after it joins the globe.
 * @param onFailure - Called for each failed tile, up to
 *   {@link MAX_REPORTED_TILE_FAILURES} times.
 * @returns A function that stops watching and restores the provider.
 */
export function watchImageryTileHealth(
  provider: ImageryProvider,
  onFailure: (failure: ImageryTileFailure) => void,
): () => void {
  let loaded = 0;
  let failed = 0;
  let stopped = false;
  const target = provider as ImageryProvider & {
    requestImage: ImageryProvider["requestImage"];
  };
  const hadOwnRequestImage = Object.prototype.hasOwnProperty.call(target, "requestImage");
  const original = target.requestImage;
  const wrapped: ImageryProvider["requestImage"] = function (
    this: ImageryProvider,
    ...args: Parameters<ImageryProvider["requestImage"]>
  ) {
    const pending = original.apply(this, args);
    // Undefined means "throttled, ask again later": not a request yet.
    if (pending)
      void Promise.resolve(pending).then(
        (image) => {
          if (image && !stopped) loaded += 1;
        },
        // The rejection reaches `errorEvent` through ImageryLayer; this branch
        // only keeps the observer from turning it into an unhandled one.
        () => undefined,
      );
    return pending;
  };
  target.requestImage = wrapped;

  const removeListener = provider.errorEvent.addEventListener((error: unknown) => {
    if (stopped) return;
    const tileError = error as { level?: unknown; message?: unknown; error?: unknown } | null;
    // Only tile failures count; a provider-wide error has no level.
    if (!tileError || typeof tileError.level !== "number") return;
    failed += 1;
    if (failed > MAX_REPORTED_TILE_FAILURES) return;
    onFailure({
      status: statusOf(tileError.error),
      message:
        typeof tileError.message === "string" && tileError.message
          ? tileError.message
          : "Tile failed to load",
      loaded,
      failed,
    });
  });

  return () => {
    if (stopped) return;
    stopped = true;
    removeListener();
    if (target.requestImage === wrapped) {
      if (hadOwnRequestImage) target.requestImage = original;
      else delete (target as { requestImage?: unknown }).requestImage;
    }
  };
}
