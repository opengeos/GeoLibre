/**
 * Secrets do not appear in wrangler.jsonc and therefore cannot be emitted by
 * `wrangler types`. Keep this declaration limited to names installed with
 * `wrangler secret put`; all configured bindings remain generated.
 */
interface Env {
  CF_AI_GATEWAY_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
}
