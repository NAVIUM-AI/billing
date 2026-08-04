import { createBrowserRouter, Navigate } from "react-router-dom";

import { LoginScreen } from "@/features/auth/LoginScreen";
import { CreditNotesListScreen } from "@/features/creditNotes/CreditNotesListScreen";
import { CustomerLedgerScreen } from "@/features/customers/CustomerLedgerScreen";
import { CustomersListScreen } from "@/features/customers/CustomersListScreen";
import { DashboardScreen } from "@/features/dashboard/DashboardScreen";
import { DriversListScreen } from "@/features/drivers/DriversListScreen";
import { InvoiceDetailPage } from "@/features/invoices/InvoiceDetailPage";
import { InvoiceDraftEditPage } from "@/features/invoices/InvoiceDraftEditPage";
import { InvoiceWizardPage } from "@/features/invoices/InvoiceWizardPage";
import { InvoicesListScreen } from "@/features/invoices/InvoicesListScreen";
import { PaymentsListScreen } from "@/features/payments/PaymentsListScreen";
import { PricingRuleDetailPage } from "@/features/pricingRules/PricingRuleDetailPage";
import { PricingRuleFormPage } from "@/features/pricingRules/PricingRuleFormPage";
import { PricingRulesListScreen } from "@/features/pricingRules/PricingRulesListScreen";
import { AgingReportScreen } from "@/features/reports/AgingReportScreen";
import { TripSheetDetailPage } from "@/features/tripSheets/TripSheetDetailPage";
import { TripSheetFormPage } from "@/features/tripSheets/TripSheetFormPage";
import { TripSheetsListScreen } from "@/features/tripSheets/TripSheetsListScreen";
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
      { path: "/dashboard", element: <DashboardScreen /> },
      { path: "/customers", element: <CustomersListScreen /> },
      { path: "/customers/:id/ledger", element: <CustomerLedgerScreen /> },
      { path: "/vehicles", element: <VehiclesListScreen /> },
      { path: "/drivers", element: <DriversListScreen /> },
      { path: "/pricing", element: <PricingRulesListScreen /> },
      { path: "/pricing/new", element: <PricingRuleFormPage /> },
      { path: "/pricing/:id/new-version", element: <PricingRuleFormPage /> },
      { path: "/pricing/:ruleType/:vehicleType", element: <PricingRuleDetailPage /> },
      { path: "/trips", element: <TripSheetsListScreen /> },
      { path: "/trips/new", element: <TripSheetFormPage /> },
      { path: "/trips/:id/edit", element: <TripSheetFormPage /> },
      { path: "/trips/:id", element: <TripSheetDetailPage /> },
      { path: "/invoices", element: <InvoicesListScreen /> },
      { path: "/invoices/new", element: <InvoiceWizardPage /> },
      { path: "/invoices/:id/edit", element: <InvoiceDraftEditPage /> },
      { path: "/invoices/:id", element: <InvoiceDetailPage /> },
      { path: "/payments", element: <PaymentsListScreen /> },
      { path: "/credit-notes", element: <CreditNotesListScreen /> },
      { path: "/reports/aging", element: <AgingReportScreen /> },
    ],
  },
  {
    path: "*",
    element: <Navigate to="/" replace />,
  },
]);
