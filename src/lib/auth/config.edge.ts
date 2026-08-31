import type { NextAuthConfig } from "next-auth";

import { env } from "../env.ts";

/**
 * Edge-safe half of the auth config: no database, no bcrypt, no providers.
 * `middleware.ts` uses this; the full config in `index.ts` spreads it and adds
 * the Credentials provider (which needs Prisma and runs only in the nodejs
 * route handler).
 */
export const authConfig = {
  secret: env.NEXTAUTH_SECRET,
  trustHost: true,
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [],
  callbacks: {
    authorized({ auth, request }) {
      // Single-user desktop: there is nobody else to be, so there is nothing
      // to check. The session-side counterpart supplies the local user id.
      if (env.DESKTOP_SINGLE_USER) return true;
      const onDashboard = request.nextUrl.pathname.startsWith("/dashboard");
      if (onDashboard) return Boolean(auth?.user);
      return true;
    },
    jwt({ token, user }) {
      if (user?.id) token.uid = user.id;
      return token;
    },
    session({ session, token }) {
      if (token.uid && session.user) session.user.id = String(token.uid);
      return session;
    },
  },
} satisfies NextAuthConfig;
