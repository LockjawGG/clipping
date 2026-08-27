"use client";

import { signOut } from "next-auth/react";

export function SignOutButton() {
  return (
    <button
      onClick={() => signOut({ redirectTo: "/login" })}
      className="text-sm text-neutral-500 underline"
    >
      Sign out
    </button>
  );
}
