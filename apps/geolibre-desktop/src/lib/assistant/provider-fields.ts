import type { AssistantProviderId } from "./provider";

/** One credential field for an AI provider, mapped onto the env var {@link ./provider} reads. */
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
  /** Other env var names {@link ./provider} also accepts for this field, so an
   * existing value under an alias is surfaced (and edited) here rather than
   * hidden behind a duplicate of the canonical name. */
  aliases?: readonly string[];
}

/** The credential fields each provider exposes, mirroring what {@link ./provider.configForProvider} reads. */
export const PROVIDER_FIELDS = {
  google: [
    {
      envKey: "GEMINI_API_KEY",
      labelKey: "settings.ai.field.apiKey",
      placeholderKey: "settings.ai.placeholder.geminiKey",
      secret: true,
      required: true,
      // provider.ts also honors these names; surface a value set under either
      // so the field is not left empty while the status reads "configured".
      aliases: ["GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY"],
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
      // provider.ts's ollamaBaseUrl() also accepts OLLAMA_HOST, so surface a
      // value set under it rather than showing the field empty while the status
      // reads "configured".
      aliases: ["OLLAMA_HOST"],
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
  bedrock: "https://docs.aws.amazon.com/bedrock/latest/userguide/getting-started.html",
};
