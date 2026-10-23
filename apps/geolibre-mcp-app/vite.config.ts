import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [viteSingleFile()],
  resolve: { dedupe: ["maplibre-gl"] },
  // Keep named catalog imports tree-shakeable; the preview needs no desktop strings.
  json: { stringify: false },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: { input: "show-map.html" },
  },
});
