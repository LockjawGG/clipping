import { ZodError } from "zod";

import { ProviderUnavailableError } from "../providers/types.ts";

/** An error with an intended HTTP status. Thrown by the service layer. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Map any thrown value to a JSON `Response`. */
export function toErrorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof ZodError) {
    return Response.json(
      { error: "invalid request", issues: err.issues.map((i) => ({ path: i.path, message: i.message })) },
      { status: 400 },
    );
  }
  if (err instanceof ProviderUnavailableError) {
    return Response.json({ error: err.message }, { status: 503 });
  }
  console.error("[api] unhandled error:", err);
  return Response.json({ error: "internal server error" }, { status: 500 });
}

type Handler<Ctx> = (req: Request, ctx: Ctx) => Promise<Response> | Response;

/** Wrap a route handler so thrown errors become the right JSON response. */
export function route<Ctx>(handler: Handler<Ctx>): Handler<Ctx> {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      return toErrorResponse(err);
    }
  };
}

/** Parse a JSON body, or 400 if it isn't valid JSON. */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ApiError(400, "request body must be valid JSON");
  }
}
