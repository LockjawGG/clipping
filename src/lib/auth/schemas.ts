import { z } from "zod";

import { MIN_PASSWORD_LENGTH } from "./password.ts";

export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(200),
});
export type Credentials = z.infer<typeof credentialsSchema>;

export const registerSchema = credentialsSchema.extend({
  name: z.string().min(1).max(120).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;
