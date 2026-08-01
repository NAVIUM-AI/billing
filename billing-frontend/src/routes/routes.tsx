import { createBrowserRouter, Navigate } from "react-router-dom";

import { LoginScreen } from "@/features/auth/LoginScreen";
import { CustomersListScreen } from "@/features/customers/CustomersListScreen";
import { DashboardPlaceholder } from "@/features/dashboard/DashboardPlaceholder";
import { DriversListScreen } from "@/features/drivers/DriversListScreen";
import { PricingRuleDetailPage } from "@/features/pricingRules/PricingRuleDetailPage";
import { PricingRuleFormPage } from "@/features/pricingRules/PricingRuleFormPage";
import { PricingRulesListScreen } from "@/features/pricingRules/PricingRulesListScreen";
import { VehiclesListScreen } from "@/features/vehicles/VehiclesListScreen";
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
      { path: "/customers", element: <CustomersListScreen /> },
      { path: "/vehicles", element: <VehiclesListScreen /> },
      { path: "/drivers", element: <DriversListScreen /> },
      { path: "/pricing", element: <PricingRulesListScreen /> },
      { path: "/pricing/new", element: <PricingRuleFormPage /> },
      { path: "/pricing/:id/new-version", element: <PricingRuleFormPage /> },
      { path: "/pricing/:ruleType/:vehicleType", element: <PricingRuleDetailPage /> },
    ],
  },
  {
    path: "*",
    element: <Navigate to="/" replace />,
  },
]);
