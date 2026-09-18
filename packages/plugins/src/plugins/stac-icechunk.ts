/**
 * Reading an Icechunk repository: a manifest rather than a Zarr hierarchy, so it reaches the
 * renderer through {@link ZarrRasterLayerOptions.store}, as a kerchunk store or a local folder does.
 *
 * `icechunk-js` rather than `@earthmover/icechunk`, whose browser build is WASI and fails with
 * `SharedArrayBuffer transfer requires self.crossOriginIsolated` — app-wide isolation next to a
 * 6.8 MB wasm payload. Revisit if earth-mover/icechunk#2065 lands an emscripten build.
 *
 * Imported dynamically: it carries its own msgpack and flatbuffers parsers.
 */

import { createZarrMetadataReader } from "./zarr-metadata-reader";
import { readCoordinateTimeAttributes, type ZarrTimeAttributes } from "./zarr-time-axis";

/**
 * The reader contract the Zarr renderer wants, and the one an Icechunk store already satisfies.
 *
 * Keys are rooted because the library's are (`AbsolutePath`), and it bites: a manifest answers
 * `/time/zarr.json` and returns nothing for `time/zarr.json`.
 */
export interface ZarrKeyReader {
  get(key: `/${string}`, options?: { signal?: AbortSignal }): Promise<Uint8Array | undefined>;
}

/** The branch a catalog reads when it names none. */
export const DEFAULT_ICECHUNK_BRANCH = "main";

/**
 * One reader per repository and branch, for the life of the page.
 *
 * Opening walks `refs` to a snapshot and then its manifests, which a cube listing a dozen variables
 * would otherwise pay for once per add. Sharing also pins those layers to one snapshot, which suits
 * a format built on immutable ones.
 *
 * The cost: a snapshot committed after the first add is not seen until the page reloads. Add an
 * expiry here if that ever matters, rather than a second cache.
 */
const openRepositories = new Map<string, Promise<ZarrKeyReader>>();

/** Forget every opened repository. Exported for tests, which must not share state between them. */
export function __resetIcechunkRepositoriesForTests(): void {
  openRepositories.clear();
}

/**
 * Open a repository for reading.
 *
 * Deliberately passes no `formatVersion`, so both spec versions open: the reader probes for a v2
 * `repo` object and falls back to v1's `refs/`. Pinning either fails on the other. The cost is one
 * 404 on `<url>/repo` for a v1 archive — the probe missing, the only request expected to fail here.
 *
 * The branch is catalog-controlled and reaches a request path unencoded (`refs/branch.<name>/`),
 * but grants nothing: the same catalog supplies `url`.
 *
 * @param signal Drops this caller out whenever it fires; the shared open runs on for the others.
 * @returns A reader over the branch's current snapshot.
 */
export function openIcechunkStore(
  url: string,
  branch: string = DEFAULT_ICECHUNK_BRANCH,
  signal?: AbortSignal,
): Promise<ZarrKeyReader> {
  return shareRepositoryOpen(
    repositoryKey(url, branch),
    async () => {
      const { IcechunkStore } = await import("icechunk-js");
      // Uncast, so a change to the library's reader contract fails the build, not the layer.
      return IcechunkStore.open(url, { branch });
    },
    signal,
  );
}

/**
 * What identifies one open repository. Encoded rather than joined, because both halves are
 * catalog-controlled: a `|` inside a URL would let one repository's entry answer for another's.
 */
export function repositoryKey(url: string, branch: string): string {
  return JSON.stringify([url, branch]);
}

/**
 * Wait on the one open for a repository, starting it if nobody has.
 *
 * Started without any caller's signal, because the open is shared: honouring one caller's abort
 * would cancel it for every other add waiting on it. Each caller leaves on its own signal instead —
 * the moment it fires, not once the walk it stopped caring about has finished.
 *
 * @param open Called only when no other caller has an open in flight or finished.
 */
export function shareRepositoryOpen(
  key: string,
  open: () => Promise<ZarrKeyReader>,
  signal?: AbortSignal,
): Promise<ZarrKeyReader> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  let pending = openRepositories.get(key);
  if (!pending) {
    pending = open();
    openRepositories.set(key, pending);
    // A failure evicts, so a store unreachable once is retried rather than refused all session.
    const opening = pending;
    void opening.catch(() => {
      if (openRepositories.get(key) === opening) openRepositories.delete(key);
    });
  }
  if (!signal) return pending;
  const work = pending;
  return new Promise<ZarrKeyReader>((resolve, reject) => {
    const abandon = () => reject(signal.reason);
    signal.addEventListener("abort", abandon, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abandon));
  });
}

/**
 * What to add a repository's layer under.
 *
 * With a `store` supplied the renderer never requests this, but it still keys the control's state,
 * so two branches of one repository must not answer to the same string — the same reason
 * {@link localZarrStoreUrl} mints one per folder. The branch rides in the fragment, which keeps the
 * path (what the layer is named from) intact and never reaches a server.
 */
export function icechunkLayerUrl(url: string, branch: string = DEFAULT_ICECHUNK_BRANCH): string {
  // Any fragment the href already carried is dropped rather than stacked: it identifies nothing
  // here, and two of them read as a mistake.
  return `${url.split("#")[0]}#icechunk=${encodeURIComponent(branch)}`;
}

/**
 * The error the panel shows for a repository that would not open, with the reason logged beside it.
 * `cause` alone reaches nobody — nothing reads it — while the log lands in the Diagnostics panel.
 */
export function repositoryOpenError(error: unknown, message: string): Error {
  console.error("Icechunk repository could not be opened", error);
  return new Error(message, { cause: error });
}

/**
 * A reader for the CF `units`/`calendar` of an Icechunk repository's coordinate. The Time Slider
 * otherwise fetches these from the store's URL, which for a repository is a run of 404s and a
 * binding that never happens.
 */
export function icechunkTimeAttributesReader(
  store: ZarrKeyReader,
): (dimension: string) => Promise<ZarrTimeAttributes | null> {
  // Only the rooting is this store's own; the decode is the same one a folder on disk gets.
  const readDocument = createZarrMetadataReader((key) => store.get(`/${key}`));
  return (dimension: string) => readCoordinateTimeAttributes(readDocument, dimension);
}
