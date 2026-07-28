import { create } from "zustand";

import type { User } from "@/types/user";

interface AuthState {
  accessToken: string | null;
  user: User | null;
  // True until the initial /auth/refresh attempt (on app mount)
  // completes — lets the app show a loader instead of flashing the
  // login screen while that request is in flight.
  isBootstrapping: boolean;
  setAuth: (token: string, user: User) => void;
  clearAuth: () => void;
  setBootstrapping: (value: boolean) => void;
}

// CRITICAL: no persist middleware here. accessToken lives in memory
// only — on a page reload it's gone by design, and the app's bootstrap
// effect (see App.tsx) re-derives it from the HttpOnly refresh_token
// cookie via POST /auth/refresh. Persisting the access token to
// localStorage would make it readable by any script on the page
// (defeats the point of using an HttpOnly cookie for the refresh
// token in the first place).
export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  user: null,
  isBootstrapping: true,
  setAuth: (token, user) => set({ accessToken: token, user }),
  clearAuth: () => set({ accessToken: null, user: null }),
  setBootstrapping: (value) => set({ isBootstrapping: value }),
}));
