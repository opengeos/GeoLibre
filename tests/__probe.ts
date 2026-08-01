// @ts-nocheck
import { readFileSync } from "node:fs";
import { DOMParser } from "linkedom";

globalThis.self = globalThis;
globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;

const path =
  "/tmp/claude-1000/-home-qiusheng-Documents-GitHub-GeoLibre/611d8264-2c0f-491f-aafb-019841eba2d5/scratchpad/super/kazawaUAV_super_overlay.kmz";

async function main() {
  const { loadDroppedVectorFiles } = await import("../apps/geolibre-desktop/src/lib/tauri-io");
  const bytes = readFileSync(path);
  const file = new File([bytes], "kazawaUAV_super_overlay.kmz");
  const started = Date.now();
  const layers = await loadDroppedVectorFiles([file], { skipModels: true });
  console.log("elapsed ms", Date.now() - started);
  console.log("layer count", layers.length);
  const kinds = new Map<string, number>();
  for (const layer of layers) {
    const kind = (layer as { kind?: string }).kind ?? ("data" in layer ? "vector" : "unknown");
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  console.log("kinds", [...kinds]);
}

void main();
