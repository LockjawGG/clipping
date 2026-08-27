import NextAuth from "next-auth";

import { authConfig } from "@/lib/auth/config.edge.ts";

// Edge-safe: authConfig has no database or bcrypt import.
export const { auth: middleware } = NextAuth(authConfig);

export const config = {
  matcher: ["/dashboard/:path*"],
};
