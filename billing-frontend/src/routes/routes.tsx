import { createBrowserRouter, Navigate } from "react-router-dom";

import { LoginScreen } from "@/features/auth/LoginScreen";
import { DashboardPlaceholder } from "@/features/dashboard/DashboardPlaceholder";
import { ProtectedRoute } from "@/routes/ProtectedRoute";

export const router = createBrowserRouter([
  {
    path: "/login",
    element: <LoginScreen />,
  },
  {
    element: <ProtectedRoute />,
    children: [
      { path: "/", element: <Navigate to="/dashboard" replace /> },
      { path: "/dashboard", element: <DashboardPlaceholder /> },
    ],
  },
  {
    path: "*",
    element: <Navigate to="/" replace />,
  },
]);
