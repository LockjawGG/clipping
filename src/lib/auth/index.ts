import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { db } from "../db.ts";
import { authConfig } from "./config.edge.ts";
import { credentialsSchema } from "./schemas.ts";
import { verifyPassword } from "./password.ts";

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: { email: { type: "email" }, password: { type: "password" } },
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;

        const user = await db.user.findUnique({ where: { email: parsed.data.email } });
        if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
          return null;
        }
        return { id: user.id, email: user.email, name: user.name ?? undefined };
      },
    }),
  ],
});
