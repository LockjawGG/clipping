import { ApiError, readJson, route } from "@/lib/api/http.ts";
import { db } from "@/lib/db.ts";
import { hashPassword } from "@/lib/auth/password.ts";
import { registerSchema } from "@/lib/auth/schemas.ts";

export const runtime = "nodejs";

/** POST /api/auth/register — create a credentials account. */
export const POST = route(async (req: Request) => {
  const input = registerSchema.parse(await readJson(req));

  const existing = await db.user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (existing) throw new ApiError(409, "an account with that email already exists");

  const user = await db.user.create({
    data: { email: input.email, name: input.name, passwordHash: await hashPassword(input.password) },
    select: { id: true, email: true },
  });
  return Response.json(user, { status: 201 });
});
