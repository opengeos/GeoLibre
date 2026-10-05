import {
  explainS3ReadError,
  parseProject,
  parseS3Url,
  resolveReadableUrl,
  s3ObjectHttpsUrl,
  useAppStore,
} from "@geolibre/core";
import { readLimitedBody } from "../components/layout/add-data/helpers";
import { fetchUrlBytes } from "./native-http";
import { isTauri } from "./tauri-io";
import { resolveProjectXyzLayers } from "./xyz-url";

/** Same cap as opening a project from a URL in the toolbar. */
const MAX_PROJECT_BYTES = 25 * 1024 * 1024;

/**
 * Fetches a `.geolibre.json` project from a URL (including `s3://` URIs, signed
 * with the app's S3 connections when one covers the bucket) and opens it,
 * replacing the current project.
 *
 * A project read with credentials is not added to Open Recent, since reopening
 * it later would need a fresh signature; a public one is remembered by its
 * object URL.
 *
 * @param sourceUrl An `http(s)://` or `s3://` URL of the project file.
 * @param translate Translates the CORS explanation for a blocked S3 read.
 * @param signal Aborts the download before the project loads.
 * @throws When the file cannot be read or is not a valid project.
 */
export async function openProjectFromUrlForPlugin(
  sourceUrl: string,
  translate?: (key: string, fallback: string, params?: Record<string, unknown>) => string,
  signal?: AbortSignal,
): Promise<void> {
  const location = parseS3Url(sourceUrl);
  const readUrl = location ? await resolveReadableUrl(sourceUrl, signal) : sourceUrl;
  // Whether the read was actually signed: a covered bucket whose credentials
  // cannot be resolved falls back to the anonymous URL, which can be remembered.
  const credentialed = readUrl !== sourceUrl && /[?&]x-amz-signature=/i.test(readUrl);
  // The URL a later reopen can use: the anonymous object URL for public S3.
  const rememberedUrl = credentialed ? null : location ? s3ObjectHttpsUrl(location) : sourceUrl;

  let text: string;
  try {
    if (isTauri()) {
      const bytes = await fetchUrlBytes(readUrl, {
        context: "Open project",
        maxBytes: MAX_PROJECT_BYTES,
      });
      const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (array.byteLength > MAX_PROJECT_BYTES) throw new Error("tooLarge");
      text = new TextDecoder().decode(array);
    } else {
      const response = await fetch(readUrl, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      // Counted as the body streams in, so an oversized object is never
      // buffered whole.
      text = new TextDecoder().decode(await readLimitedBody(response, MAX_PROJECT_BYTES));
    }
  } catch (error) {
    if (signal?.aborted) return;
    if (error instanceof Error && /tooLarge|download limit/.test(error.message)) {
      throw new Error("Project file is too large to load (over 25 MB).");
    }
    throw location ? await explainS3ReadError(sourceUrl, error, translate) : error;
  }

  const project = await resolveProjectXyzLayers(parseProject(text), signal);
  if (signal?.aborted) return;
  useAppStore.getState().loadProject(project, rememberedUrl);
}
