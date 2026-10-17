import type { Context } from "hono";
import * as z from "zod/mini";
import { formatIssues } from "../mcp/registry.ts";
import type { Principal } from "../auth/service.ts";

export type AppEnv = { Variables: { principal: Principal; sessionToken: string } };

export class HttpError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 415;
  constructor(status: HttpError["status"], message: string) {
    super(message);
    this.status = status;
  }
}

// Reads a JSON body and checks its shape. Only application/json is accepted, which a
// cross-site form cannot send.
export async function readJson<S extends z.ZodMiniType>(c: Context, schema: S): Promise<z.infer<S>> {
  if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Send the body as application/json");
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, "The body is not valid JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, `Invalid request: ${formatIssues(parsed.error)}`);
  return parsed.data;
}

// A passkey ceremony's answer: the shape is checked by the passkey library, not here.
export const ceremony = z.object({
  challengeId: z.string(),
  response: z.record(z.string(), z.unknown()),
  deviceName: z.optional(z.string()),
});
