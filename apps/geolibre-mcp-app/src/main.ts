import "./maplibre-worker";
import "./style.css";
import { parseProject } from "@geolibre/core";
import { App, applyDocumentTheme, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { addProtocol, removeProtocol, type Map } from "maplibre-gl";
import { z } from "zod";
import { closeMapPreview, createNetworkConsent, type NetworkConsent } from "./network-consent";
import { renderProject } from "./render";
import { previewOrigins, unsupportedContent } from "./unsupported-content";

const app = new App({ name: "GeoLibre map preview", version: "1.0.0" });
const mapEl = document.getElementById("map")!;
const statusEl = document.getElementById("status")!;
const consentEl = document.getElementById("network-consent")!;
let map: Map | undefined;
let consent: NetworkConsent | undefined;
let generation = 0;
let loading = "";
let notices: string[] = [];
const failures = new globalThis.Map<string, { count: number; message: string }>();
const summarySchema = z.object({ path: z.string().optional() });
const previewSchema = z.object({ project: z.unknown(), previewId: z.string().min(1) });
const previewSessionSchema = z.object({ previewId: z.string().min(1) });

async function disposePreview(): Promise<void> {
  const previousConsent = consent;
  consent = undefined;
  map?.remove();
  map = undefined;
  removeProtocol("geolibre-preview");
  await previousConsent?.dispose();
}

function closeLatePreview(data: { structuredContent?: unknown }): void {
  const parsed = previewSessionSchema.safeParse(data.structuredContent);
  if (!parsed.success) return;
  void closeMapPreview(parsed.data.previewId, (params, options) =>
    app.callServerTool(params, options),
  );
}

app.onteardown = async () => {
  generation++;
  await disposePreview();
  return {};
};

function updateStatus(): void {
  const messages = loading ? [loading, ...notices] : [...notices];
  for (const [source, failure] of failures) {
    messages.push(
      `${source}: ${failure.message}${failure.count > 1 ? ` (${failure.count} failures)` : ""}`,
    );
  }
  statusEl.textContent = messages.join("\n");
  statusEl.hidden = messages.length === 0;
  mapEl.setAttribute("aria-busy", String(Boolean(loading)));
}

function showFailure(message: string): void {
  loading = "";
  failures.set("Project", { count: 1, message });
  updateStatus();
}

function applyContext(context: McpUiHostContext): void {
  if (context.theme) {
    applyDocumentTheme(context.theme);
    document.documentElement.classList.toggle("dark", context.theme === "dark");
  }
  const dimensions = context.containerDimensions;
  const height = dimensions && "height" in dimensions ? dimensions.height : undefined;
  if (typeof height === "number") {
    mapEl.style.height = `${height}px`;
    map?.resize();
  }
}

app.addEventListener("hostcontextchanged", applyContext);
app.addEventListener("toolresult", async (result) => {
  const current = ++generation;
  await disposePreview();
  if (current !== generation) return;
  loading = "Loading project…";
  notices = [];
  failures.clear();
  updateStatus();
  if (result.isError) {
    showFailure(result.content?.find((item) => item.type === "text")?.text ?? "show_map failed");
    return;
  }
  const summary = summarySchema.safeParse(result.structuredContent ?? {});
  if (!summary.success) {
    showFailure("The tool returned an invalid project summary.");
    return;
  }
  const { path } = summary.data;
  if (!path) {
    showFailure("The tool result carried no project path.");
    return;
  }
  if (!app.getHostCapabilities()?.serverTools) {
    showFailure(
      "This host does not let previews call server tools, so the map data cannot be loaded. Reopen this view in a host with server-tool support.",
    );
    return;
  }
  try {
    const data = await app.callServerTool({ name: "get_map_preview", arguments: { path } });
    const preview = previewSchema.safeParse(data.structuredContent);
    if (current !== generation) {
      closeLatePreview(data);
      return;
    }
    if (data.isError) {
      showFailure(
        data.content?.find((item) => item.type === "text")?.text ?? "get_map_preview failed",
      );
      return;
    }
    if (!preview.success) {
      closeLatePreview(data);
      throw new Error(
        "The server returned an invalid preview session. Reopen the preview or update the GeoLibre MCP server.",
      );
    }
    let project: ReturnType<typeof parseProject>;
    try {
      project = parseProject(JSON.stringify(preview.data.project));
    } catch (error) {
      closeLatePreview(data);
      throw error;
    }
    consent = createNetworkConsent(
      consentEl,
      preview.data.previewId,
      (params, options) => app.callServerTool(params, options),
      (notice) => {
        if (current !== generation) return;
        if (!notices.includes(notice)) notices.push(notice);
        updateStatus();
      },
      previewOrigins(project),
    );
    addProtocol("geolibre-preview", consent.load);
    notices = unsupportedContent(project);
    loading = "Loading map resources…";
    updateStatus();
    map = renderProject(mapEl, project, {
      transformRequest: consent.transformRequest,
      onReady() {
        if (current !== generation) return;
        loading = "";
        updateStatus();
      },
      onError(source, message) {
        if (current !== generation) return;
        const previous = failures.get(source);
        failures.set(source, { count: (previous?.count ?? 0) + 1, message });
        updateStatus();
      },
    });
  } catch (error) {
    if (current !== generation) return;
    await disposePreview();
    if (current !== generation) return;
    showFailure(
      `Could not load the preview: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
});

try {
  await app.connect();
  applyContext(app.getHostContext() ?? {});
} catch (error) {
  showFailure(
    `Could not connect to the preview host: ${error instanceof Error ? error.message : String(error)}`,
  );
}
