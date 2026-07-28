import { useEffect } from "react";
import { RouterProvider } from "react-router-dom";

import * as authApi from "@/features/auth/auth.api";
import { refreshAccessToken } from "@/lib/api";
import { router } from "@/routes/routes";
import { useAuthStore } from "@/stores/auth.store";

function FullScreenLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-accent-50">
      <p className="text-sm text-gray-500">Loading...</p>
    </div>
  );
}

function App() {
  const isBootstrapping = useAuthStore((s) => s.isBootstrapping);

  useEffect(() => {
    let cancelled = false;

    // On mount, try to silently re-establish a session from the
    // HttpOnly refresh_token cookie — this is what makes "hard refresh
    // the browser, still logged in" work, since the in-memory
    // accessToken is gone the moment the page reloads (by design, see
    // auth.store.ts). /auth/refresh itself doesn't return a user object
    // (see lib/schemas/auth.ts), so a successful refresh is followed by
    // GET /auth/me to hydrate it.
    async function bootstrap() {
      try {
        // Goes through the SAME single-flight guard the interceptor
        // uses (see api.ts's own comment) — not authApi.refresh()
        // directly. Caught via real browser testing: calling the raw
        // endpoint here let React StrictMode's dev-mode double-effect
        // fire two concurrent refresh calls, and the second one (racing
        // against the first call's already-rotated cookie) tripped the
        // backend's reuse-detection and killed the whole session.
        const newToken = await refreshAccessToken();
        // Set the token into the store BEFORE calling me() — the
        // request interceptor reads the token from THIS store at
        // send-time, and me() requires Authorization: Bearer. Getting
        // this order backwards (calling me() first) means it goes out
        // with no Authorization header at all and 401s, which silently
        // discards an otherwise-successful refresh (also caught via
        // real browser testing, not by inspection).
        useAuthStore.setState({ accessToken: newToken });
        const { user } = await authApi.me();
        if (!cancelled) {
          useAuthStore.getState().setAuth(newToken, user);
        }
      } catch {
        // No cookie, expired cookie, or reuse detected — stay logged
        // out. Not an error to surface to the user; it's the normal
        // shape of "nobody's logged in yet."
        if (!cancelled) {
          useAuthStore.getState().clearAuth();
        }
      } finally {
        if (!cancelled) {
          useAuthStore.getState().setBootstrapping(false);
        }
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  if (isBootstrapping) {
    return <FullScreenLoader />;
  }

  return <RouterProvider router={router} />;
}

export default App;
