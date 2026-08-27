"use client";

import { signOut } from "next-auth/react";

export function SignOutButton() {
  return (
    <button
      onClick={() => signOut({ redirectTo: "/login" })}
      className="text-sm text-muted underline underline-offset-2 hover:text-text"
    >
      Sign out
    </button>
  );
}
