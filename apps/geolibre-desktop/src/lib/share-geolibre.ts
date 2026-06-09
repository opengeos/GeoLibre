// Uploads a serialized GeoLibre project to share.geolibre.app via its
// `POST /api/projects` endpoint, authenticated with a personal API token the
// user created on the website. Used by the Project > Share action.

export type ShareVisibility = "public" | "unlisted" | "private";

export interface ShareUploadResult {
  username: string;
  slug: string;
  projectUrl: string;
  viewerUrl: string;
  rawJsonUrl: string;
}

export interface ShareUploadOptions {
  token: string;
  filename: string;
  content: string;
  visibility: ShareVisibility;
  /** Override the share host; defaults to the configured/production URL. */
  baseUrl?: string;
  signal?: AbortSignal;
  /** Injected for testing; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_SHARE_BASE_URL = "https://share.geolibre.app";

/** Resolve the share host from the Vite env, falling back to production. */
export function resolveShareBaseUrl(): string {
  const configured = import.meta.env?.VITE_GEOLIBRE_SHARE_URL;
  if (typeof configured === "string" && configured.trim()) {
    return configured.trim().replace(/\/+$/, "");
  }
  return DEFAULT_SHARE_BASE_URL;
}

interface ShareProjectResponse {
  project?: {
    username?: string;
    slug?: string;
    projectUrl?: string;
    viewerUrl?: string;
    rawJsonUrl?: string;
  };
}

export async function uploadProjectToShare(
  options: ShareUploadOptions,
): Promise<ShareUploadResult> {
  const token = options.token.trim();
  if (!token) {
    throw new Error(
      "Add a share.geolibre.app API token in Settings before sharing.",
    );
  }

  const base = (options.baseUrl ?? resolveShareBaseUrl()).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(`${base}/api/projects`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filename: options.filename,
        content: options.content,
        visibility: options.visibility,
      }),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error(
      "Could not reach share.geolibre.app. Check your internet connection.",
    );
  }

  if (!response.ok) {
    throw new Error(await uploadErrorMessage(response));
  }

  const payload = (await response.json().catch(() => ({}))) as ShareProjectResponse;
  const project = payload.project;
  if (!project?.projectUrl || !project.rawJsonUrl) {
    throw new Error("share.geolibre.app returned an unexpected response.");
  }
  return {
    username: project.username ?? "",
    slug: project.slug ?? "",
    projectUrl: project.projectUrl,
    viewerUrl: project.viewerUrl ?? "",
    rawJsonUrl: project.rawJsonUrl,
  };
}

async function uploadErrorMessage(response: Response): Promise<string> {
  if (response.status === 401) {
    return "Invalid or expired API token. Update it in Settings.";
  }
  if (response.status === 403) {
    return "This API token is not allowed to upload projects.";
  }
  if (response.status === 429) {
    return "Too many uploads. Please wait a while and try again.";
  }
  const body = (await response.json().catch(() => null)) as
    | { error?: string }
    | null;
  if (body?.error) return body.error;
  return `Upload failed (HTTP ${response.status}).`;
}
