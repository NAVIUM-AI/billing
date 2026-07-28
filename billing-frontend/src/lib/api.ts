import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { toast } from "sonner";

import { useAuthStore } from "@/stores/auth.store";
import { AUTH_ERROR_CODES } from "@/lib/errorCodes";
import type { ApiErrorResponse } from "@/types/api";

const REFRESH_URL = "/auth/refresh";

export const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL,
  // Essential: the HttpOnly refresh_token cookie only rides along on
  // credentialed requests. Harmless to set globally even though the
  // cookie itself is scoped server-side to /api/v1/auth (see
  // auth.routes.js's REFRESH_COOKIE_PATH) — non-auth requests simply
  // won't have a cookie to send regardless of this flag.
  withCredentials: true,
  headers: {
    "Content-Type": "application/json",
  },
});

apiClient.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

function redirectToLogin() {
  useAuthStore.getState().clearAuth();
  // Not react-router's navigate — this interceptor runs outside the
  // React tree (axios doesn't know about the router), so a hard
  // navigation is the only option that always works, including from
  // deep inside a promise chain triggered by a background request.
  if (window.location.pathname !== "/login") {
    window.location.href = "/login";
  }
}

// Marks a request as already-retried-once, so a second 401 on the
// SAME request (e.g. the freshly-issued token is somehow already bad)
// forces a redirect instead of looping refresh attempts forever.
interface RetryableConfig extends InternalAxiosRequestConfig {
  _retried?: boolean;
}

let refreshPromise: Promise<string> | null = null;

// Single-flight refresh: if five requests 401 at once (e.g. a page
// that fires several queries in parallel right as the access token
// expires), they all await the SAME in-flight refresh call rather
// than each independently hitting /auth/refresh — the second physical
// call would 401 with REFRESH_TOKEN_REUSED against the first call's
// already-rotated cookie, taking down every one of that user's
// sessions (see the reuse-detection note in errorCodes.ts).
//
// Exported so App.tsx's bootstrap effect uses this SAME guard instead
// of calling POST /auth/refresh directly — caught via real browser
// testing: React 18/19 StrictMode double-invokes effects in dev mode,
// which fired two concurrent, unguarded refresh calls on mount. The
// first rotated the cookie; the second arrived carrying the
// now-already-consumed token and tripped the backend's reuse-detection,
// which revokes EVERY refresh token the user has — turning a harmless
// dev-mode double-render into a real, full session kill. Routing both
// callers through this one function means only one physical network
// call is ever in flight, no matter how many callers ask for it at once.
export function refreshAccessToken(): Promise<string> {
  if (!refreshPromise) {
    refreshPromise = apiClient
      .post<{ accessToken: string }>(REFRESH_URL)
      .then((res) => res.data.accessToken)
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<ApiErrorResponse>) => {
    if (!error.response) {
      toast.error("Cannot reach server. Check your connection.");
      return Promise.reject(error);
    }

    const { status, data } = error.response;
    const code = data?.error?.code;
    const originalRequest = error.config as RetryableConfig | undefined;
    const isRefreshCall = originalRequest?.url?.includes(REFRESH_URL);

    // A failure OF the refresh call itself is always just rejected here
    // — never auto-redirected. This matters on cold app load: App.tsx's
    // bootstrap effect calls refresh() directly to check for an
    // existing session, and getting REFRESH_TOKEN_MISSING back (there's
    // no cookie yet — completely normal for a first-time visitor) must
    // NOT force a hard navigation to /login before the router has even
    // mounted. The two real callers of a failed refresh — this
    // bootstrap effect, and the retry catch block below — each decide
    // for themselves what "refresh failed" means in their own context.
    if (isRefreshCall) {
      return Promise.reject(error);
    }

    if (status === 401 && code === AUTH_ERROR_CODES.ACCESS_TOKEN_EXPIRED) {
      if (!originalRequest || originalRequest._retried) {
        redirectToLogin();
        return Promise.reject(error);
      }
      try {
        const newToken = await refreshAccessToken();
        useAuthStore.setState({ accessToken: newToken });
        originalRequest._retried = true;
        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return apiClient(originalRequest);
      } catch (refreshError) {
        // The retry's own refresh attempt failed — this IS a
        // previously-logged-in user whose session just died, so
        // redirecting here (unlike the bootstrap case above) is correct.
        redirectToLogin();
        return Promise.reject(refreshError);
      }
    }

    if (
      status === 401 &&
      (code === AUTH_ERROR_CODES.AUTH_REQUIRED || code === AUTH_ERROR_CODES.AUTH_INVALID)
    ) {
      redirectToLogin();
    }

    return Promise.reject(error);
  },
);
