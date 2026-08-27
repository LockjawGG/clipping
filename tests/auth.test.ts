import test from "node:test";
import assert from "node:assert/strict";

import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from "../src/lib/auth/password.ts";
import { credentialsSchema, registerSchema } from "../src/lib/auth/schemas.ts";

// --- password hashing --------------------------------------------

test("hashPassword produces a bcrypt hash that verifyPassword accepts", async () => {
  const hash = await hashPassword("correct horse battery");
  assert.match(hash, /^\$2[aby]\$/);
  assert.equal(await verifyPassword("correct horse battery", hash), true);
  assert.equal(await verifyPassword("wrong password here", hash), false);
});

test("verifyPassword is false for a null or malformed hash", async () => {
  assert.equal(await verifyPassword("whatever value", null), false);
  assert.equal(await verifyPassword("whatever value", "not-a-hash"), false);
});

test("hashPassword rejects a password below the minimum length", async () => {
  await assert.rejects(() => hashPassword("a".repeat(MIN_PASSWORD_LENGTH - 1)));
});

// --- credential schemas -----------------------------------------

test("credentialsSchema lowercases and trims the email", () => {
  const parsed = credentialsSchema.parse({ email: "  USER@Example.COM ", password: "longenough1" });
  assert.equal(parsed.email, "user@example.com");
});

test("credentialsSchema rejects a bad email or a short password", () => {
  assert.throws(() => credentialsSchema.parse({ email: "nope", password: "longenough1" }));
  assert.throws(() => credentialsSchema.parse({ email: "a@b.co", password: "short" }));
});

test("registerSchema makes name optional but keeps the credential rules", () => {
  assert.equal(registerSchema.parse({ email: "a@b.co", password: "longenough1" }).name, undefined);
  assert.equal(
    registerSchema.parse({ email: "a@b.co", password: "longenough1", name: "Ada" }).name,
    "Ada",
  );
  assert.throws(() => registerSchema.parse({ email: "a@b.co", password: "x" }));
});
