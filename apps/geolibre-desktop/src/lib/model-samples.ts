import type { DeckVizScenegraphConfig } from "@geolibre/plugins";

interface ModelSample {
  id: string;
  labelKey: "addData.deckViz.sampleAirplane" | "addData.deckViz.sampleShanghai";
  location: [number, number];
  scenegraph: DeckVizScenegraphConfig;
  bounds?: [number, number, number, number];
}

export const SHANGHAI_MODEL_SAMPLE: ModelSample = {
  id: "shanghai",
  labelKey: "addData.deckViz.sampleShanghai",
  // WGS84 ground-level origin of the meter-scale, Y-up exported model.
  location: [121.495, 31.235],
  scenegraph: {
    modelUrl: "https://data.source.coop/giswqs/opengeos/shanghai-3d-model.glb",
    sizeScale: 1,
    sizeMinPixels: 0,
    bearing: 0,
    altitude: 0,
    orientationRoll: 90,
    translation: [0, 0, 0],
  },
  bounds: [121.470, 31.220, 121.520, 31.250],
};

/** Use geographic sample bounds only while its original placement is intact. */
export function modelSampleBounds(config: DeckVizScenegraphConfig, lng: number, lat: number) {
  return [SHANGHAI_MODEL_SAMPLE].find((sample) =>
    sample.scenegraph.modelUrl === config.modelUrl &&
    sample.location[0] === lng && sample.location[1] === lat &&
    sample.scenegraph.sizeScale === config.sizeScale &&
    sample.scenegraph.bearing === config.bearing,
  )?.bounds;
}
