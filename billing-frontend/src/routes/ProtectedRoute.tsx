import { Navigate, Outlet } from "react-router-dom";

import { Shell } from "@/components/layout/Shell";
import { useAuth } from "@/features/auth/useAuth";

export function ProtectedRoute() {
  const { isAuthenticated, isBootstrapping } = useAuth();

  // App.tsx's top-level loader covers this — returning null here (as
  // opposed to a second spinner) avoids a double-loading-state flash.
  if (isBootstrapping) {
    return null;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return (
    <Shell>
      <Outlet />
    </Shell>
  );
}
