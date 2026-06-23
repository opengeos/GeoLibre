import type { AssistantProviderId } from "./provider";

/**
 * Declarative description of a single credential field for an AI provider, used
 * by the Settings → AI Providers section to render a labeled input instead of
 * asking the user to type a raw environment-variable name. Each field maps one
 * to one onto a runtime environment variable that {@link ./provider} already
 * reads, so the structured UI and the generic Environment variables list stay
 * two views of the same underlying storage.
 */
export interface ProviderField {
  /** The runtime environment variable this field reads from and writes to. */
  envKey: string;
  /** i18n key for the human-readable field label (e.g. "API key"). */
  labelKey: string;
  /** i18n key for the placeholder that hints the expected value format. */
  placeholderKey: string;
  /** Mask the value by default and offer a reveal toggle (secrets, keys). */
  secret: boolean;
  /** Whether the provider needs this field before it counts as configured. */
  required: boolean;
}

/**
 * The credential fields each provider exposes, mirroring exactly what
 * {@link ./provider.configForProvider} reads. The first env var name in each
 * provider's key list is used (the alternates like `GOOGLE_API_KEY` remain
 * available through the generic Environment variables list). Selecting a
 * provider in the AI section renders this list as the dynamic template.
 */
export const PROVIDER_FIELDS = {
  google: [
    {
      envKey: "GEMINI_API_KEY",
      labelKey: "settings.ai.field.apiKey",
      placeholderKey: "settings.ai.placeholder.geminiKey",
      secret: true,
      required: true,
    },
  ],
  anthropic: [
    {
      envKey: "ANTHROPIC_API_KEY",
      labelKey: "settings.ai.field.apiKey",
      placeholderKey: "settings.ai.placeholder.anthropicKey",
      secret: true,
      required: true,
    },
  ],
  openai: [
    {
      envKey: "OPENAI_API_KEY",
      labelKey: "settings.ai.field.apiKey",
      placeholderKey: "settings.ai.placeholder.openaiKey",
      secret: true,
      required: true,
    },
  ],
  ollama: [
    {
      envKey: "OLLAMA_BASE_URL",
      labelKey: "settings.ai.field.baseUrl",
      placeholderKey: "settings.ai.placeholder.ollamaBaseUrl",
      secret: false,
      required: true,
    },
    {
      envKey: "OLLAMA_MODEL",
      labelKey: "settings.ai.field.model",
      placeholderKey: "settings.ai.placeholder.ollamaModel",
      secret: false,
      required: false,
    },
  ],
  bedrock: [
    {
      envKey: "AWS_ACCESS_KEY_ID",
      labelKey: "settings.ai.field.accessKeyId",
      placeholderKey: "settings.ai.placeholder.awsAccessKey",
      secret: true,
      required: true,
    },
    {
      envKey: "AWS_SECRET_ACCESS_KEY",
      labelKey: "settings.ai.field.secretAccessKey",
      placeholderKey: "settings.ai.placeholder.awsSecretKey",
      secret: true,
      required: true,
    },
    {
      envKey: "AWS_REGION",
      labelKey: "settings.ai.field.region",
      placeholderKey: "settings.ai.placeholder.awsRegion",
      secret: false,
      required: false,
    },
    {
      envKey: "AWS_SESSION_TOKEN",
      labelKey: "settings.ai.field.sessionToken",
      placeholderKey: "settings.ai.placeholder.awsSessionToken",
      secret: true,
      required: false,
    },
  ],
  custom: [
    {
      envKey: "OPENAI_COMPATIBLE_BASE_URL",
      labelKey: "settings.ai.field.baseUrl",
      placeholderKey: "settings.ai.placeholder.customBaseUrl",
      secret: false,
      required: true,
    },
    {
      envKey: "OPENAI_COMPATIBLE_MODEL",
      labelKey: "settings.ai.field.model",
      placeholderKey: "settings.ai.placeholder.customModel",
      secret: false,
      required: true,
    },
    {
      envKey: "OPENAI_COMPATIBLE_API_KEY",
      labelKey: "settings.ai.field.apiKey",
      placeholderKey: "settings.ai.placeholder.customApiKey",
      secret: true,
      required: false,
    },
  ],
} as const satisfies Record<AssistantProviderId, readonly ProviderField[]>;

/**
 * Where to obtain credentials for each provider, surfaced as a help link below
 * the fields. Providers without a meaningful sign-up page (custom endpoints)
 * are omitted.
 */
export const PROVIDER_DOCS_URL: Partial<Record<AssistantProviderId, string>> = {
  google: "https://aistudio.google.com/apikey",
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  ollama: "https://ollama.com/download",
  bedrock:
    "https://docs.aws.amazon.com/bedrock/latest/userguide/getting-started.html",
};
