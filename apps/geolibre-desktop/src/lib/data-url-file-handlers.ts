/**
 * Offers a file downloaded by `?data=` or the embed `addData` command to the
 * plugin file handlers (GeoLibre#3283), through the same routing a dropped
 * file takes, so claims, errors and status messages behave alike.
 */

import type { GeoLibreFileHandler } from "@geolibre/plugins";
import {
  type DropLeaf,
  type FileHandlerDropResult,
  offerDropToFileHandlers,
  toDroppedFile,
} from "./plugin-file-drop";

/** What a data URL load needs from the file handler registry. */
export interface DataUrlFileHandlers {
  /** The registered handlers, in registration order. */
  list: () => GeoLibreFileHandler[];
  /** The handler that declares a `dataType` hint, if any. */
  forDataType: (name: string) => GeoLibreFileHandler | undefined;
  /** Resolves once plugins have had the chance to register their handlers. */
  ready?: () => Promise<void>;
}

/** The outcome of offering a downloaded file: the handlers that opened it or failed. */
export type RemoteFileHandlerResult = Pick<FileHandlerDropResult<string>, "opened" | "failed">;

/**
 * Whether URL loads may reach file handlers. Drops are closed in the read-only
 * viewer and without `data:add`, and handlers are closed to URL loads the same
 * way, so the registry opens no door the drop path keeps shut.
 */
export function dataUrlFileHandlers(
  gate: { viewer: boolean; canAddData: boolean },
  source: DataUrlFileHandlers,
): DataUrlFileHandlers | undefined {
  return gate.viewer || !gate.canAddData ? undefined : source;
}

function memoryLeaf(name: string, bytes: Uint8Array): DropLeaf<string> {
  return {
    origin: name,
    name,
    size: bytes.byteLength,
    read: async () => bytes.slice().buffer,
    readRange: async (offset, length) => bytes.subarray(offset, offset + length),
  };
}

/**
 * Offer a downloaded file to the handlers: extension filter, `claim`, then
 * `open`, exactly as for a drop.
 *
 * @param name - The file name, with the extension the URL or response gives.
 * @param bytes - The downloaded bytes.
 * @param handlers - The registered handlers.
 * @returns The handlers that opened the file or failed to; both empty when none claimed it.
 */
export async function offerRemoteFileToHandlers(
  name: string,
  bytes: Uint8Array,
  handlers: GeoLibreFileHandler[],
): Promise<RemoteFileHandlerResult> {
  const leaf = memoryLeaf(name, bytes);
  const { opened, failed } = await offerDropToFileHandlers([leaf], [name], handlers);
  return { opened, failed };
}

/**
 * Hand a downloaded file straight to the handler a `dataType` hint named,
 * without the extension filter or `claim`. A throwing `open` is reported, as
 * for a drop.
 */
export async function openRemoteFileWithHandler(
  handler: GeoLibreFileHandler,
  name: string,
  bytes: Uint8Array,
): Promise<RemoteFileHandlerResult> {
  try {
    await handler.open([toDroppedFile(memoryLeaf(name, bytes))]);
    return { opened: [handler], failed: [] };
  } catch (error) {
    return { opened: [], failed: [{ handler, error }] };
  }
}

/** The layers a URL load can see and remove. */
export interface UrlLoadLayerStore {
  layerIds: () => string[];
  removeLayer: (id: string) => void;
}

/** Why a style cannot go with a file a plugin opens. */
export const STYLE_WITH_HANDLER_MESSAGE = "A style cannot be applied to a file opened by a plugin.";

/** Remove the layers that appeared since `before`: what a plugin handler added. */
export function discardHandledLayers(store: UrlLoadLayerStore, before: ReadonlySet<string>): void {
  for (const id of store.layerIds()) if (!before.has(id)) store.removeLayer(id);
}

/**
 * Finish a load a plugin file handler took, which has already run and added its
 * own layers. Returns the layers that appeared. A failed `open`, a style, or an
 * abort throws instead, and removes what the handler added, like the built-in
 * paths that never leave a half-loaded result behind.
 */
export function finishHandledLoad({
  remote,
  hasStyle,
  before,
  store,
  signal,
}: {
  remote: Pick<RemoteFileHandlerResult, "failed">;
  hasStyle: boolean;
  before: ReadonlySet<string>;
  store: UrlLoadLayerStore;
  signal?: AbortSignal;
}): string[] {
  const added = () => store.layerIds().filter((id) => !before.has(id));
  const discard = () => discardHandledLayers(store, before);
  if (signal?.aborted) {
    discard();
    throw new DOMException("The operation was aborted", "AbortError");
  }
  if (remote.failed.length > 0) {
    discard();
    throw new Error(
      remote.failed
        .map(
          ({ handler, error }) =>
            `${handler.name}: ${error instanceof Error ? error.message : String(error)}`,
        )
        .join(" "),
    );
  }
  if (hasStyle) {
    discard();
    throw new Error(STYLE_WITH_HANDLER_MESSAGE);
  }
  return added();
}

/** The registry for a URL load, with the viewer flag and `data:add` read at call time. */
export function urlFileHandlers(deps: {
  isViewer: () => boolean;
  canAddData: () => boolean;
  source: DataUrlFileHandlers;
}): DataUrlFileHandlers | undefined {
  return dataUrlFileHandlers(
    { viewer: deps.isViewer(), canAddData: deps.canAddData() },
    deps.source,
  );
}
