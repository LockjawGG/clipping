import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { env } from "@/lib/env.ts";
import { APP_IDENTITY } from "@/lib/app-identity.ts";

export const metadata = { title: `Register · ${APP_IDENTITY.label}` };

export default function RegisterPage() {
  // Desktop mode has no accounts, so these pages have nothing to do. Reaching
  // one means a stale link or a bookmark; send it where the user meant to go
  // rather than showing a form that cannot accomplish anything.
  if (env.DESKTOP_SINGLE_USER) redirect("/dashboard");

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <AuthForm mode="register" />
    </main>
  );
}
