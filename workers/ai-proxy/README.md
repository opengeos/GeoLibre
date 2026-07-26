# GeoLibre AI proxy

Cloudflare Worker that gives GeoLibre an OpenAI-compatible
`/v1/chat/completions` endpoint without shipping an AI provider key in the
application. It routes through Cloudflare AI Gateway's unified API, which
supports OpenAI, Anthropic, Google Gemini, and Workers AI with one request
format. It streams responses and enforces an origin allowlist, model allowlist,
request-size cap, output-token cap, and per-client rate limit.

## Configure and deploy

1. Review `AI_GATEWAY_ID`, `ALLOWED_ORIGINS`, `ALLOWED_MODELS`, and the limits
   in `wrangler.jsonc`.
2. In Cloudflare, enable AI Gateway Unified Billing and create a scoped API
   token with AI Gateway permission. Store it interactively (never put it in
   source or Wrangler variables):

   ```sh
   cd workers/ai-proxy
   npx wrangler secret put CF_AI_GATEWAY_TOKEN
   npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
   ```

3. Validate and deploy:

   ```sh
   npm run typecheck
   npm run deploy:dry-run
   npx wrangler deploy
   ```

4. Build GeoLibre with the deployed Worker URL:

   ```sh
   GEOLIBRE_AI_URL=https://ai.geolibre.app \
   GEOLIBRE_AI_MODEL=openai/gpt-5.6 \
   npm run build
   ```

Change `GEOLIBRE_AI_MODEL` to another allowlisted model, such as
`anthropic/claude-opus-5` or `google/gemini-3.6-flash`, to change provider
without changing the client protocol.

The URL is public configuration; only `CF_AI_GATEWAY_TOKEN` is secret. Origin
checks and edge rate limiting reduce casual abuse but are not user
authentication. For a public production service with meaningful spend, place
Cloudflare Access or another identity layer in front and rate-limit by a
verified user identifier. Configure AI Gateway spend limits as a second,
account-level cost control.
