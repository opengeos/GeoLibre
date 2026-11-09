import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import project from "../../../package.json";

const ENDPOINT = "https://mcp.parallel.ai/mcp";
const USER_AGENT = `GeoLibre/${project.version} (+https://github.com/opengeos/GeoLibre)`;

/** One bounded anonymous MCP session; no caller credentials enter this boundary. */
export async function parallelSearch(query: string, signal: AbortSignal) {
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    /** Keep every SDK request on Parallel and cap how long a completed search waits for DELETE. */
    fetch: async (url, init) => {
      if (String(url) !== ENDPOINT) throw new Error("Unexpected Parallel destination");
      const headers = new Headers(init?.headers);
      headers.set("User-Agent", USER_AGENT);
      const signals = [signal, ...(init?.signal ? [init.signal] : [])];
      if (init?.method === "DELETE") signals.push(AbortSignal.timeout(500));
      const response = await fetch(url, {
        ...init,
        headers,
        redirect: "manual",
        signal: AbortSignal.any(signals),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error("Parallel redirects are not allowed");
      }
      return response;
    },
  });
  const client = new Client(
    { name: "geolibre", version: project.version },
    { capabilities: {}, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );
  try {
    await client.connect(transport, { signal });
    const tools = await client.listTools({}, { signal });
    if (!tools.tools.some((tool) => tool.name === "web_search")) {
      throw new Error("Parallel web_search is unavailable");
    }
    const result = CallToolResultSchema.parse(
      await client.callTool(
        { name: "web_search", arguments: { objective: query, search_queries: [query] } },
        undefined,
        { signal },
      ),
    );
    if (result.isError) throw new Error("Parallel search failed");
    const text = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const data = result.structuredContent ?? JSON.parse(text);
    if (!Array.isArray(data.results)) throw new Error("Invalid Parallel search results");
    return data.results.slice(0, 6).map((hit: Record<string, unknown>) => {
      if (
        typeof hit.url !== "string" ||
        !/^https?:\/\//i.test(hit.url) ||
        !Array.isArray(hit.excerpts) ||
        !hit.excerpts.every((part) => typeof part === "string")
      ) {
        throw new Error("Invalid Parallel search result");
      }
      return {
        title: typeof hit.title === "string" ? hit.title : hit.url,
        url: hit.url,
        content: hit.excerpts.join("\n\n"),
      };
    });
  } finally {
    // Teardown is best-effort and may never replace results or the primary error.
    try {
      await transport.terminateSession();
    } catch {
      /* remote session may already be gone */
    }
    await client.close().catch(() => {});
  }
}
