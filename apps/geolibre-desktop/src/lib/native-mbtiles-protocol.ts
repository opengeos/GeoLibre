import { addProtocol } from "maplibre-gl";
import {
  nativeMbtilesProtocolUrl,
  usesLocalhostCustomSchemeOrigin,
  type NativeMediaPlatform,
} from "./local-media-url";

const PREFIX = "geolibre-native-mbtiles://tile/";
let registered = false;

/** Dispatch vector reads through the main document. Android WebView intercepts
 * its native URI requests there, but not requests made by map workers. */
export function nativeMbtilesTileUrl(path: string, platform?: NativeMediaPlatform): string {
  // WebView2's native HTTP form also works with Mapbox's worker transport.
  // Keep that representation rather than replacing it with a MapLibre-only
  // protocol on Windows. Android's native HTTP form needs the document bridge.
  const windows = platform
    ? platform === "windows"
    : usesLocalhostCustomSchemeOrigin() && !/Android/i.test(navigator.userAgent ?? "");
  if (windows) return nativeMbtilesProtocolUrl(path, "windows");
  return `${PREFIX}{z}/{x}/{y}?path=${encodeURIComponent(path)}`;
}

export function registerNativeMbtilesProtocol(): void {
  if (registered) return;
  addProtocol("geolibre-native-mbtiles", async (request, controller) => {
    if (!request.url.toLowerCase().startsWith(PREFIX))
      throw new Error("Invalid native MBTiles tile URL");
    const template = nativeMbtilesProtocolUrl("");
    const origin = template.slice(0, template.indexOf("{z}"));
    const response = await fetch(origin + request.url.slice(PREFIX.length), {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Native MBTiles tile read failed (${response.status})`);
    return { data: await response.arrayBuffer() };
  });
  registered = true;
}
