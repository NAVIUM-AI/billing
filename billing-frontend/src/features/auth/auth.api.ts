import { apiClient } from "@/lib/api";
import {
  loginResponseSchema,
  meResponseSchema,
  refreshResponseSchema,
  type LoginPayload,
  type LoginResponse,
  type MeResponse,
  type RefreshResponse,
} from "@/lib/schemas/auth";

export async function login(payload: LoginPayload): Promise<LoginResponse> {
  const res = await apiClient.post("/auth/login", payload);
  return loginResponseSchema.parse(res.data);
}

export async function logout(): Promise<void> {
  await apiClient.post("/auth/logout");
}

// Returns only a new accessToken — the backend's /auth/refresh does
// NOT return a user object (see lib/schemas/auth.ts's own comment).
// Callers that need the user after a refresh must also call me().
export async function refresh(): Promise<RefreshResponse> {
  const res = await apiClient.post("/auth/refresh");
  return refreshResponseSchema.parse(res.data);
}

export async function me(): Promise<MeResponse> {
  const res = await apiClient.get("/auth/me");
  return meResponseSchema.parse(res.data);
}
