import { formatIssues, type ToolDef } from "./registry.ts";

// Dual-era Streamable HTTP MCP server (stateless, POST only).
//  - modern (2026-07-28): no handshake; every request carries _meta + mirrored headers
//  - legacy (<= 2025-11-25): `initialize` handshake, but we never issue a session
const MODERN = ["2026-07-28"];
const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
const CAPABILITIES = { tools: { listChanged: false } };

const E_PARSE = -32700;
const E_INVALID_REQUEST = -32600;
const E_METHOD_NOT_FOUND = -32601;
const E_INVALID_PARAMS = -32602;
const E_HEADER_MISMATCH = -32020;
const E_UNSUPPORTED_VERSION = -32022;

type Id = string | number | null;
type Rpc = { jsonrpc?: string; id?: Id; method?: unknown; params?: any };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (id: Id, result: Record<string, unknown>) => json({ jsonrpc: "2.0", id, result });
const fail = (id: Id | undefined, code: number, message: string, status = 200, data?: unknown) =>
  json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }, status);

// Header values may use the =?base64?...?= sentinel (spec: Value Encoding).
function decodeHeader(value: string | null): string | null {
  if (value && value.startsWith("=?base64?") && value.endsWith("?=")) {
    const bytes = Uint8Array.from(atob(value.slice(9, -2)), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return value;
}

export type McpServerOptions<Ctx> = {
  serverInfo: { name: string; version: string };
  tools: ToolDef<Ctx>[];
  // The tools/list entries, serialized at build time (scripts/gen-tools.ts).
  toolsJson: string;
  // Anything thrown by a tool that is not a deliberate, user-facing error ends up here.
  userFacingError: (error: unknown) => string | null;
};

export function createMcpHandler<Ctx>({ serverInfo, tools, toolsJson, userFacingError }: McpServerOptions<Ctx>) {
  const byName = new Map(tools.map((t) => [t.name, t]));

  async function callTool(ctx: Ctx, scopes: readonly string[], params: any) {
    const tool = typeof params?.name === "string" ? byName.get(params.name) : undefined;
    if (!tool) return { error: `Unknown tool: ${String(params?.name)}` };
    const text = (message: string) => ({ result: { content: [{ type: "text", text: message }], isError: true } });
    if (!scopes.includes(tool.scope)) return text(`Missing scope: ${tool.scope}`);
    const parsed = tool.input.safeParse(params.arguments ?? {});
    if (!parsed.success) return text(`Invalid arguments: ${formatIssues(parsed.error)}`);
    try {
      return { result: await tool.handler(parsed.data, ctx) };
    } catch (error) {
      const message = userFacingError(error);
      if (message !== null) return text(message);
      console.error("tool failed", tool.name, error);
      return text("Internal error");
    }
  }

  return async function handle(request: Request, ctx: Ctx, scopes: readonly string[]): Promise<Response> {
    // No GET stream and no sessions in a stateless server (spec: 405).
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });

    let msg: Rpc;
    try {
      msg = (await request.json()) as Rpc;
    } catch {
      return fail(null, E_PARSE, "Parse error", 400);
    }
    if (Array.isArray(msg) || typeof msg !== "object" || msg === null || typeof msg.method !== "string") {
      return fail(null, E_INVALID_REQUEST, "Expected a single JSON-RPC request or notification", 400);
    }
    const { id, method, params } = msg as Rpc & { method: string };

    const requested = params?._meta?.[META_VERSION];
    const modern = typeof requested === "string";
    const withType = (r: Record<string, unknown>) => (modern ? { resultType: "complete", ...r } : r);

    if (modern) {
      const header = request.headers.get("mcp-protocol-version");
      const methodHeader = request.headers.get("mcp-method");
      const nameHeader = decodeHeader(request.headers.get("mcp-name"));
      if (header !== requested) return fail(id, E_HEADER_MISMATCH, "Header mismatch: MCP-Protocol-Version", 400);
      if (methodHeader !== method) return fail(id, E_HEADER_MISMATCH, "Header mismatch: Mcp-Method", 400);
      if (method === "tools/call" && nameHeader !== params?.name) {
        return fail(id, E_HEADER_MISMATCH, "Header mismatch: Mcp-Name", 400);
      }
      if (!MODERN.includes(requested)) {
        return fail(id, E_UNSUPPORTED_VERSION, "Unsupported protocol version", 400, {
          supported: [...MODERN, ...LEGACY],
          requested,
        });
      }
    }

    if (method.startsWith("notifications/") || id === undefined) return new Response(null, { status: 202 });

    switch (method) {
      case "initialize": {
        if (modern) return fail(id, E_METHOD_NOT_FOUND, "Method not found", 404);
        const v = params?.protocolVersion;
        return ok(id, {
          protocolVersion: LEGACY.includes(v) ? v : LEGACY[0],
          capabilities: CAPABILITIES,
          serverInfo,
        });
      }
      case "ping":
        return ok(id, withType({}));
      case "server/discover":
        return ok(id, withType({
          supportedVersions: [...MODERN, ...LEGACY],
          capabilities: CAPABILITIES,
          _meta: { [META_SERVER_INFO]: serverInfo },
        }));
      case "tools/list": {
        // The set may depend on the caller's authorization, so it is not public-cacheable.
        const extra = modern ? ',"ttlMs":60000,"cacheScope":"private"' : "";
        const type = modern ? '"resultType":"complete",' : "";
        return new Response(
          `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":{${type}"tools":${toolsJson}${extra}}}`,
          { headers: { "content-type": "application/json" } },
        );
      }
      case "tools/call": {
        const out = await callTool(ctx, scopes, params);
        if ("error" in out) return fail(id, E_INVALID_PARAMS, out.error!);
        return ok(id, withType(out.result as Record<string, unknown>));
      }
      default:
        return modern
          ? fail(id, E_METHOD_NOT_FOUND, "Method not found", 404)
          : fail(id, E_METHOD_NOT_FOUND, "Method not found");
    }
  };
}
