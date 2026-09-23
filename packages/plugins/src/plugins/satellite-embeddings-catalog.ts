/**
 * Catalog of popular pre-computed satellite embedding datasets.
 *
 * An embedding dataset stores, for every pixel or image patch, a vector
 * produced by a geospatial foundation model. Two layouts exist:
 *
 * - `pixel`: a multi-band raster where each band is one embedding dimension
 *   (AlphaEarth / Google Satellite Embedding, Tessera).
 * - `patch`: one vector per image chip, stored as GeoParquet rows with a point
 *   or polygon geometry (Earth Index, Clay, Major TOM).
 *
 * `capabilities` says what the Satellite Embeddings panel can do with a dataset
 * in the browser. A dataset with none is listed for discovery only, with links
 * to where its data lives.
 */

/** Identifier of a dataset in {@link SATELLITE_EMBEDDING_DATASETS}. */
export type SatelliteEmbeddingDatasetId =
  | "alphaearth"
  | "tessera"
  | "earth-index"
  | "clay"
  | "major-tom"
  | "copernicus-embed";

/** What the panel supports for one dataset. */
export interface SatelliteEmbeddingCapabilities {
  /** Find the files/tiles that cover an area. */
  search: boolean;
  /** Render the embeddings on the map. */
  visualize: boolean;
  /** Download the embeddings. */
  download: boolean;
}

/** One entry in the dataset catalog. */
export interface SatelliteEmbeddingDataset {
  id: SatelliteEmbeddingDatasetId;
  /** Display name (a proper noun, so not translated). */
  name: string;
  /** Who produced the embeddings. */
  provider: string;
  /** Foundation model the embeddings come from. */
  model: string;
  kind: "pixel" | "patch";
  /** Ground spacing of one embedding, e.g. `"10 m"`. */
  resolution: string;
  /** Number of embedding dimensions. */
  dimensions: number;
  /** Years with data, newest last. Empty when the dataset has no annual axis. */
  years: number[];
  /** Coverage in words, e.g. `"Global land"`. */
  coverage: string;
  /** SPDX license id; omitted when the publisher does not state one. */
  license?: string;
  /** Attribution text the license asks users to show. */
  attribution?: string;
  /** Landing page for the data. */
  dataUrl: string;
  /** Paper or model documentation. */
  paperUrl?: string;
  capabilities: SatelliteEmbeddingCapabilities;
}

const range = (start: number, end: number): number[] =>
  Array.from({ length: end - start + 1 }, (_, index) => start + index);

/** The datasets the panel lists, in display order. */
export const SATELLITE_EMBEDDING_DATASETS: readonly SatelliteEmbeddingDataset[] = [
  {
    id: "alphaearth",
    name: "AlphaEarth Foundations (Google Satellite Embedding)",
    provider: "Google / Google DeepMind",
    model: "AlphaEarth Foundations",
    kind: "pixel",
    resolution: "10 m",
    dimensions: 64,
    years: range(2017, 2025),
    coverage: "Global land and coastal waters",
    license: "CC-BY-4.0",
    attribution:
      "The AlphaEarth Foundations Satellite Embedding dataset is produced by Google and Google DeepMind.",
    dataUrl: "https://source.coop/tge-labs/aef",
    paperUrl: "https://arxiv.org/abs/2507.22291",
    capabilities: { search: true, visualize: true, download: true },
  },
  {
    id: "tessera",
    name: "Tessera",
    provider: "University of Cambridge",
    model: "Tessera",
    kind: "pixel",
    resolution: "10 m",
    dimensions: 128,
    years: range(2017, 2025),
    coverage: "Global land (0.1° tiles)",
    dataUrl: "https://github.com/ucam-eo/geotessera",
    paperUrl: "https://arxiv.org/abs/2506.20380",
    capabilities: { search: true, visualize: false, download: true },
  },
  {
    id: "earth-index",
    name: "Earth Index",
    provider: "Earth Genome",
    model: "SoftCon (DINOv2 ViT-S/14)",
    kind: "patch",
    resolution: "~320 m",
    dimensions: 384,
    years: [2024],
    coverage: "Global land (Sentinel-2 MGRS tiles)",
    license: "CC-BY-4.0",
    dataUrl: "https://source.coop/earthgenome/earthindexembeddings",
    paperUrl: "https://github.com/zhu-xlab/softcon",
    capabilities: { search: true, visualize: true, download: true },
  },
  {
    id: "clay",
    name: "Clay",
    provider: "Clay Foundation",
    model: "Clay v0 / v1.5",
    kind: "patch",
    resolution: "5.12 km",
    dimensions: 768,
    years: [],
    coverage: "Global (partial)",
    license: "ODC-By-1.0",
    dataUrl: "https://source.coop/clay/clay-model-v0-embeddings",
    paperUrl: "https://clay-foundation.github.io/model/",
    capabilities: { search: false, visualize: false, download: false },
  },
  {
    id: "major-tom",
    name: "Major TOM",
    provider: "ESA Φ-lab",
    model: "SigLIP, DINOv2, SSL4EO and others",
    kind: "patch",
    resolution: "2.1–3.6 km",
    dimensions: 2048,
    years: [],
    coverage: "Global",
    license: "CC-BY-SA-4.0",
    dataUrl: "https://huggingface.co/Major-TOM",
    paperUrl: "https://arxiv.org/abs/2412.05600",
    capabilities: { search: false, visualize: false, download: false },
  },
  {
    id: "copernicus-embed",
    name: "Copernicus-Embed",
    provider: "TUM / Zhu Lab",
    model: "Copernicus-FM",
    kind: "pixel",
    resolution: "0.25°",
    dimensions: 768,
    years: [2021],
    coverage: "Global",
    license: "CC-BY-4.0",
    dataUrl: "https://github.com/zhu-xlab/Copernicus-FM",
    paperUrl: "https://arxiv.org/abs/2503.11849",
    capabilities: { search: false, visualize: false, download: false },
  },
];

/** Looks up a dataset by id. */
export function getSatelliteEmbeddingDataset(
  id: SatelliteEmbeddingDatasetId,
): SatelliteEmbeddingDataset {
  const dataset = SATELLITE_EMBEDDING_DATASETS.find((candidate) => candidate.id === id);
  if (!dataset) throw new Error(`Unknown satellite embedding dataset: ${id}`);
  return dataset;
}
