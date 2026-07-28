import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});
export type LoginPayload = z.infer<typeof loginSchema>;

// Matches user.repository.js's PUBLIC_COLUMNS row shape exactly
// (snake_case, no camelCase transform on the backend) — see
// src/types/user.ts's own comment for why this isn't normalized to
// camelCase here.
export const userSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  email: z.string().email(),
  full_name: z.string(),
  role: z.enum(["owner", "admin", "accountant", "staff", "viewer"]),
  is_active: z.boolean(),
});

// POST /auth/login response — { user, accessToken }.
export const loginResponseSchema = z.object({
  user: userSchema,
  accessToken: z.string(),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

// POST /auth/refresh response — accessToken ONLY, no user object
// (auth.routes.js: `res.status(200).json({ accessToken })`). Rehydrating
// the user after a refresh requires a separate GET /auth/me call.
export const refreshResponseSchema = z.object({
  accessToken: z.string(),
});
export type RefreshResponse = z.infer<typeof refreshResponseSchema>;

// GET /auth/me response — { user }.
export const meResponseSchema = z.object({
  user: userSchema,
});
export type MeResponse = z.infer<typeof meResponseSchema>;
