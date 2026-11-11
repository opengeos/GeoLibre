import { withDeadline } from "./model-discovery";

export interface UberLLMModel {
  id: string;
  name: string;
}

const UBERLLM_MODELS_URL = "https://api.uberllm.dev/v1/models";
const DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * Fetch the public UberLLM catalog without sending user credentials.
 *
 * The catalog mixes chat, image, video, music, and speech models. The assistant
 * can only drive models that return text and accept tools, so those are the
 * only rows kept. Catalog order is preserved.
 */
export async function discoverUberLLMModels(signal?: AbortSignal): Promise<UberLLMModel[]> {
  const requestSignal = withDeadline(signal, DISCOVERY_TIMEOUT_MS);
  const response = await fetch(UBERLLM_MODELS_URL, { signal: requestSignal });
  if (!response.ok) throw new Error(`UberLLM returned HTTP ${response.status}`);

  const payload: unknown = await response.json();
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("data" in payload) ||
    !Array.isArray(payload.data)
  ) {
    throw new Error("UberLLM returned an invalid model catalog");
  }

  const models: UberLLMModel[] = [];
  const seen = new Set<string>();
  for (const entry of payload.data) {
    const model = toolCapableTextModel(entry);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

function toolCapableTextModel(entry: unknown): UberLLMModel | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as {
    id?: unknown;
    display_name?: unknown;
    architecture?: { output_modalities?: unknown };
    supported_parameters?: unknown;
  };
  const output = record.architecture?.output_modalities;
  if (!Array.isArray(output) || !output.includes("text")) return null;
  const parameters = record.supported_parameters;
  if (!Array.isArray(parameters) || !parameters.includes("tools")) return null;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return null;
  const name = typeof record.display_name === "string" ? record.display_name.trim() : "";
  return { id, name: name || id };
}
