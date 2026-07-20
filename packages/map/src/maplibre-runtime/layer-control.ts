import type { MapLibreHostedRuntime } from "./types";

/** Adapter-owned implementation for the built-in Layer Control descriptor. */
export const maplibreLayerControlRuntime: MapLibreHostedRuntime = {
  activate: ({ client }, { position }) =>
    client.controls.setBuiltInState("layer-control", {
      visible: true,
      ...(position ? { position } : {}),
    }),
  deactivate: ({ client }) => {
    client.controls.setBuiltInState("layer-control", { visible: false });
  },
  setPosition: ({ client }, position) =>
    client.controls.setBuiltInState("layer-control", { position }),
};
