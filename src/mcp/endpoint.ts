import type { Actor, ItemService } from "../items/service.ts";
import type { RecipeService } from "../recipes/service.ts";
import { VERSION } from "../version.ts";
import { createMcpHandler } from "./protocol.ts";
import { TOOLS_JSON } from "./tools.generated.ts";
import { INSTRUCTIONS, missingScope, tools, userFacingError } from "./tools.ts";

export type McpPrincipal = { actor: Actor; scopes: string[] };

// What the endpoint needs from the app: who is calling and the data layer.
export type McpDeps = {
  authenticate(request: Request): Promise<McpPrincipal | null>;
  // Where the client can discover the authorization server (RFC 9728).
  resourceMetadataUrl(request: Request): string;
  items: ItemService;
  recipes: RecipeService;
};

const handle = createMcpHandler({
  serverInfo: { name: "ienolist", version: VERSION },
  tools,
  toolsJson: TOOLS_JSON,
  userFacingError,
  missingScope,
  instructions: INSTRUCTIONS,
  // One line per request in the logs: which methods and tools the assistants really use.
  onRequest: ({ method, ...rest }) => console.log(JSON.stringify({ mcp: method, ...rest })),
});

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
  return handle(request, { items: deps.items, recipes: deps.recipes, actor: principal.actor }, principal.scopes);
}
