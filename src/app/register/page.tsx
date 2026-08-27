import { AuthForm } from "@/components/auth-form";

export const metadata = { title: "Register · Clipper" };

export default function RegisterPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <AuthForm mode="register" />
    </main>
  );
}
