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

   To enable the optional `/tavily` search route used by the external NASA
   OPERA plugin, also store the Tavily key on the Worker:

   ```sh
   npx wrangler secret put TAVILY_API_KEY
   ```

   The Worker can be deployed without this optional secret. Chat remains
   available, and `/tavily` returns `503 Search is not configured` until the
   secret is added. Both routes share the one `AI_RATE_LIMITER` budget per
   client, so the configured limit is what a single user may cost you in total
   rather than a separate allowance each for chat and search.

   ### Serving `/tavily` from a model's own web search

   `/tavily` can instead be answered by an endpoint that speaks the Anthropic
   messages API and exposes the server-side `web_search` tool -- a self-hosted
   [cli-proxy-api](https://github.com/router-for-me/CLIProxyAPI), for example --
   which removes the Tavily dependency entirely. The route keeps its name and
   its response shape, so no client changes are needed.

   | Setting | Required | Meaning |
   | --- | --- | --- |
   | `SEARCH_BACKEND` | no | `tavily` (default) or `messages`. Any other value is treated as `tavily`. |
   | `SEARCH_MESSAGES_URL` | for `messages` | Base URL, e.g. `https://cli-proxy.example.org`. `/v1/messages` is appended. |
   | `SEARCH_MESSAGES_API_KEY` | for `messages` | Bearer token for that endpoint. Store with `wrangler secret put`. |
   | `SEARCH_MESSAGES_MODEL` | no | Defaults to `gpt-5.6-luna`. |

   Tavily remains the default, so an existing deployment is unchanged until
   `SEARCH_BACKEND=messages` is set deliberately. Like the Tavily path, the
   route returns `503 Search is not configured` when its settings are missing.

   Two differences are worth knowing before switching. Anthropic returns each
   hit's page text as opaque `encrypted_content`, so the model writes the
   per-source snippets that ground quantified figures; they are extracts it
   produces rather than verbatim provider content, and the cited URLs are
   restricted to ones the search actually returned -- *when* the backend reports
   them. A gateway fronting a non-Anthropic model may return the
   `web_search_tool_result` blocks with an empty `content` array: the search ran,
   but its hits never arrive, so there is nothing to check the citations against
   and the model's URLs are passed through on its word alone. Rather than drop
   every source, the route serves them and logs `"grounded": false` on that
   request, so a backend that always strips the hits is visible in the Worker's
   logs. And a search plus a synthesis pass is slower and far more token-hungry
   than a Tavily call -- expect tens of thousands of tokens per search against
   whatever account backs `SEARCH_MESSAGES_URL`.

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
  -e GEOLIBRE_AI_MODEL=openai/gpt-5.6-luna \
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
  --data '{"model":"openai/gpt-5.6-luna","messages":[{"role":"user","content":"Hello"}]}'
```

Expected status: `401 Unauthorized`. Test the intended path through the
password-protected Docker host instead:

```sh
curl -u 'admin:change-me' http://localhost:8080/ai/v1/chat/completions \
  -H 'Content-Type: application/json' \
  --data '{"model":"openai/gpt-5.6-luna","messages":[{"role":"user","content":"Reply OK"}],"max_completion_tokens":64}'
```

The client supplies only the Docker username and password. nginx adds the
instance token when it forwards the request.
