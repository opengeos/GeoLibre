import { withDeadline } from "./model-discovery";

export interface LlmtrModel {
  id: string;
  name: string;
}

const LLMTR_MODELS_URL = "https://llmtr.com/v1/models";
const DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * Fetch the public LLMTR catalog without sending user credentials.
 *
 * The catalog is OpenAI-shaped (`{ data: [{ id, ... }] }`). Some entries may
 * also carry OpenRouter-style `architecture` / `supported_parameters` fields;
 * when those are present, only tool-capable text models are kept. Catalog
 * order is preserved.
 */
export async function discoverLlmtrModels(signal?: AbortSignal): Promise<LlmtrModel[]> {
  const requestSignal = withDeadline(signal, DISCOVERY_TIMEOUT_MS);
  const response = await fetch(LLMTR_MODELS_URL, { signal: requestSignal });
  if (!response.ok) throw new Error(`LLMTR returned HTTP ${response.status}`);

  const payload: unknown = await response.json();
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("data" in payload) ||
    !Array.isArray(payload.data)
  ) {
    throw new Error("LLMTR returned an invalid model catalog");
  }

  const models: LlmtrModel[] = [];
  const seen = new Set<string>();
  for (const entry of payload.data) {
    const model = catalogModel(entry);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

function catalogModel(entry: unknown): LlmtrModel | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as {
    id?: unknown;
    name?: unknown;
    architecture?: { output_modalities?: unknown };
    supported_parameters?: unknown;
  };
  const output = record.architecture?.output_modalities;
  if (Array.isArray(output) && !output.includes("text")) return null;
  const parameters = record.supported_parameters;
  if (Array.isArray(parameters) && !parameters.includes("tools")) return null;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return null;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  return { id, name: name || id };
}
