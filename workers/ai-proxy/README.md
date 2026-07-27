# GeoLibre AI proxy

Cloudflare Worker that gives GeoLibre an OpenAI-compatible
`/v1/chat/completions` endpoint without shipping an AI provider key in the
application. It routes through Cloudflare AI Gateway's unified API, which
supports OpenAI, Anthropic, Google Gemini, and Workers AI with one request
format. It streams responses and requires a server-side GeoLibre instance
token in addition to enforcing a model allowlist, request-size cap,
output-token cap, and per-client rate limit.

## Configure and deploy

1. Review `AI_GATEWAY_ID`, `ALLOWED_MODELS`, and the limits in
   `wrangler.jsonc`.
2. In Cloudflare, enable AI Gateway Unified Billing and create a scoped API
   token with AI Gateway permission. Store it interactively (never put it in
   source or Wrangler variables):

   ```sh
   cd workers/ai-proxy
   npx wrangler secret put CF_AI_GATEWAY_TOKEN
   npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
   npx wrangler secret put GEOLIBRE_AI_PROXY_TOKEN
   ```

   Generate the instance token with `openssl rand -hex 32`. Store the same
   value in the Docker deployment's secret environment; never add it to source
   control or a frontend build.

3. Validate and deploy:

   ```sh
   npm run typecheck
   npm run deploy:dry-run
   npx wrangler deploy
   ```

4. Set the Docker client's URL to the same-origin `/ai` path and let nginx
   inject the server-only instance token:

```sh
docker run --rm -p 8080:80 \
  -e GEOLIBRE_AUTH_USER=admin \
  -e GEOLIBRE_AUTH_PASSWORD='change-me' \
  -e GEOLIBRE_AI_URL=/ai \
  -e GEOLIBRE_AI_MODEL=openai/gpt-5.5 \
  -e GEOLIBRE_AI_PROXY_URL=https://ai.geolibre.app \
  -e GEOLIBRE_AI_PROXY_TOKEN="$GEOLIBRE_AI_PROXY_TOKEN" \
  ghcr.io/opengeos/geolibre:latest
```

`GEOLIBRE_AI_PROXY_TOKEN` must match the Worker secret. The browser receives
only `/ai` and the model ID; nginx removes the user's Basic credentials, and
the Worker rejects calls without the instance token. The entrypoint injects the
token on every `/ai` request, so gate the route yourself -- with
`GEOLIBRE_AUTH_USER`/`GEOLIBRE_AUTH_PASSWORD` or your own authentication -- or
anyone who can reach the container spends against your account. Use HTTPS in
front of Docker on untrusted networks, and set `GEOLIBRE_TRUSTED_PROXIES` to
that proxy's IP or CIDR so rate limiting still sees individual clients.

Do not set `GEOLIBRE_AI_URL=https://ai.geolibre.app` in a public browser build:
the Worker deliberately requires a token that must not be shipped to a browser.
Change `GEOLIBRE_AI_MODEL` to another Chat Completions-compatible allowlisted
model, such as `anthropic/claude-opus-5` or `google/gemini-3.6-flash`, to
change provider without changing the client protocol.

## Verify authentication

The health endpoint remains public:

```sh
curl https://ai.geolibre.app/health
```

A direct inference request without the server token must fail:

```sh
curl -i https://ai.geolibre.app/v1/chat/completions \
  -H 'Content-Type: application/json' \
  --data '{"model":"openai/gpt-5.5","messages":[{"role":"user","content":"Hello"}]}'
```

Expected status: `401 Unauthorized`. Test the intended path through the
password-protected Docker host instead:

```sh
curl -u 'admin:change-me' http://localhost:8080/ai/v1/chat/completions \
  -H 'Content-Type: application/json' \
  --data '{"model":"openai/gpt-5.5","messages":[{"role":"user","content":"Reply OK"}],"max_completion_tokens":64}'
```

The client supplies only the Docker username and password. nginx adds the
instance token when it forwards the request.
