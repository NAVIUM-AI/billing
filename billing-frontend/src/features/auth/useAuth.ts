import { useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";

import { useAuthStore } from "@/stores/auth.store";
import * as authApi from "@/features/auth/auth.api";
import type { LoginPayload } from "@/lib/schemas/auth";

type LoginResult = { success: true } | { success: false; error: unknown };

export function useAuth() {
  const navigate = useNavigate();
  const { user, accessToken, isBootstrapping, setAuth, clearAuth } =
    useAuthStore(
      useShallow((s) => ({
        user: s.user,
        accessToken: s.accessToken,
        isBootstrapping: s.isBootstrapping,
        setAuth: s.setAuth,
        clearAuth: s.clearAuth,
      })),
    );

  async function handleLogin(payload: LoginPayload): Promise<LoginResult> {
    try {
      const { user, accessToken } = await authApi.login(payload);
      setAuth(accessToken, user);
      return { success: true };
    } catch (error) {
      return { success: false, error };
    }
  }

  async function handleLogout() {
    try {
      await authApi.logout();
    } finally {
      // Always clear local state even if the network call fails —
      // the user clicked "sign out," so the UI must reflect that
      // regardless of whether the backend request round-trips.
      clearAuth();
      navigate("/login", { replace: true });
    }
  }

  return {
    user,
    accessToken,
    isAuthenticated: Boolean(accessToken && user),
    isBootstrapping,
    login: handleLogin,
    logout: handleLogout,
  };
}
