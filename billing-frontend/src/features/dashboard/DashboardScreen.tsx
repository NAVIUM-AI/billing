import { PageHeader } from "@/components/PageHeader";
import { useAuth } from "@/features/auth/useAuth";
import { useBusinessProfile } from "@/features/settings/settings.hooks";
import { ReceivablesAgingWidget } from "@/features/dashboard/widgets/ReceivablesAgingWidget";
import { RecentActivityWidget } from "@/features/dashboard/widgets/RecentActivityWidget";
import { RevenueThisMonthWidget } from "@/features/dashboard/widgets/RevenueThisMonthWidget";
import { TopCustomersByOutstandingWidget } from "@/features/dashboard/widgets/TopCustomersByOutstandingWidget";

export function DashboardScreen() {
  const { user } = useAuth();
  const { data: profile } = useBusinessProfile();

  return (
    <div>
      <PageHeader
        title={`Hello, ${user?.full_name ?? ""}`}
        description={`Here's what's happening at ${profile?.name ?? "your business"} today`}
      />

      <div className="grid grid-cols-12 gap-6">
        <div className="col-span-12 md:col-span-4">
          <RevenueThisMonthWidget />
        </div>
        <div className="col-span-12 md:col-span-8">
          <ReceivablesAgingWidget />
        </div>
        <div className="col-span-12 md:col-span-6">
          <TopCustomersByOutstandingWidget />
        </div>
        <div className="col-span-12 md:col-span-6">
          <RecentActivityWidget />
        </div>
      </div>
    </div>
  );
}
