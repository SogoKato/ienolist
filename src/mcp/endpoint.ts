import type { Actor, ItemService } from "../items/service.ts";
import { createMcpHandler } from "./protocol.ts";
import { tools, userFacingError } from "./tools.ts";

export type McpPrincipal = { actor: Actor; scopes: string[] };

// What the endpoint needs from the app: who is calling and the data layer.
export type McpDeps = {
  authenticate(request: Request): Promise<McpPrincipal | null>;
  // Where the client can discover the authorization server (RFC 9728).
  resourceMetadataUrl(request: Request): string;
  items: ItemService;
};

const handle = createMcpHandler({ serverInfo: { name: "household-lists", version: "0.0.0" }, tools, userFacingError });

export async function handleMcpRequest(request: Request, deps: McpDeps): Promise<Response> {
  const principal = await deps.authenticate(request);
  if (!principal) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer resource_metadata="${deps.resourceMetadataUrl(request)}"`,
      },
    });
  }
  return handle(request, { items: deps.items, actor: principal.actor }, principal.scopes);
}
