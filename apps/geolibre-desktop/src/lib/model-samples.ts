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
  // Only the fields the dialog prefills belong here: picking a sample copies
  // the model URL, scale, bearing and altitude into the form, and the config
  // that is actually submitted is rebuilt from those inputs. Anything else set
  // here would look configurable without taking effect.
  scenegraph: {
    modelUrl: "https://data.source.coop/giswqs/opengeos/shanghai-3d-model.glb",
    sizeScale: 1,
    bearing: 0,
    altitude: 0,
  },
  bounds: [121.47, 31.22, 121.52, 31.25],
};

/** Use geographic sample bounds only while its original placement is intact. */
export function modelSampleBounds(config: DeckVizScenegraphConfig, lng: number, lat: number) {
  return [SHANGHAI_MODEL_SAMPLE].find(
    (sample) =>
      sample.scenegraph.modelUrl === config.modelUrl &&
      sample.location[0] === lng &&
      sample.location[1] === lat &&
      sample.scenegraph.sizeScale === config.sizeScale &&
      sample.scenegraph.bearing === config.bearing,
  )?.bounds;
}
