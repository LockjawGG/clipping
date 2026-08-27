import { AuthForm } from "@/components/auth-form";

export const metadata = { title: "Sign in · Clipper" };

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <AuthForm mode="login" />
    </main>
  );
}
