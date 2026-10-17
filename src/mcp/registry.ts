import * as z from "zod/mini";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

// Matches MCP tool annotations. Without readOnlyHint, destructiveHint defaults
// to true, so tools that only add or reshape data set it to false explicitly.
export type ToolAnnotations = { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };

export interface ToolDef<Ctx, S extends z.ZodMiniType = z.ZodMiniType> {
  name: string;
  description: string;
  input: S;
  scope: string;
  annotations: ToolAnnotations;
  handler: (args: z.infer<S>, ctx: Ctx) => Promise<ToolResult>;
}

export function defineTool<Ctx, S extends z.ZodMiniType>(tool: ToolDef<Ctx, S>): ToolDef<Ctx, S> {
  return tool;
}

export function formatIssues(error: z.core.$ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

// tools/list is identical for every request, so serialize it once per isolate.
export function serializeTools(tools: ToolDef<never>[]): string {
  return JSON.stringify(
    tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.input, { io: "input" }),
      annotations: t.annotations,
    })),
  );
}
