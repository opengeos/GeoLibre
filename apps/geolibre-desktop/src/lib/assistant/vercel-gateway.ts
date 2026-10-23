import { withDeadline } from "./model-discovery";

export interface VercelGatewayModel {
  id: string;
  name: string;
}

const VERCEL_GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
const DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * Fetch the public Vercel AI Gateway catalog without sending user credentials.
 *
 * The catalog mixes embeddings, image models, and chat models. The assistant
 * can only drive language models that accept tools and return text, so those
 * are the only rows kept. Catalog order is preserved.
 */
export async function discoverVercelGatewayModels(
  signal?: AbortSignal,
): Promise<VercelGatewayModel[]> {
  const requestSignal = withDeadline(signal, DISCOVERY_TIMEOUT_MS);
  const response = await fetch(VERCEL_GATEWAY_MODELS_URL, { signal: requestSignal });
  if (!response.ok) throw new Error(`Vercel AI Gateway returned HTTP ${response.status}`);

  const payload: unknown = await response.json();
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("data" in payload) ||
    !Array.isArray(payload.data)
  ) {
    throw new Error("Vercel AI Gateway returned an invalid model catalog");
  }

  const models: VercelGatewayModel[] = [];
  const seen = new Set<string>();
  for (const entry of payload.data) {
    const model = toolCapableLanguageModel(entry);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

function toolCapableLanguageModel(entry: unknown): VercelGatewayModel | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as {
    id?: unknown;
    name?: unknown;
    type?: unknown;
    modalities?: { output?: unknown };
    supported_parameters?: unknown;
  };
  if (record.type !== "language") return null;
  const output = record.modalities?.output;
  if (!Array.isArray(output) || !output.includes("text")) return null;
  const parameters = record.supported_parameters;
  if (!Array.isArray(parameters) || !parameters.includes("tools")) return null;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return null;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  return { id, name: name || id };
}
