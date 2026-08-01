import { Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { DataTable, type DataTableColumn } from "@/components/DataTable";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { useCurrentPricingRules } from "@/features/pricingRules/pricingRules.hooks";
import { formatRuleSummary } from "@/features/pricingRules/ruleSummary";
import { RULE_TYPE_LABELS, VEHICLE_TYPE_LABELS } from "@/lib/constants/enums";
import type { PricingRule } from "@/types/pricingRule";

export function PricingRulesListScreen() {
  const navigate = useNavigate();
  const { data, isLoading } = useCurrentPricingRules();

  function goToHistory(rule: PricingRule) {
    navigate(`/pricing/${rule.rule_type}/${rule.vehicle_type}`);
  }

  const columns: DataTableColumn<PricingRule>[] = [
    { key: "rule_type", label: "Service Type", render: (r) => RULE_TYPE_LABELS[r.rule_type] },
    { key: "vehicle_type", label: "Vehicle Type", render: (r) => VEHICLE_TYPE_LABELS[r.vehicle_type] },
    { key: "summary", label: "Current Rate", render: (r) => formatRuleSummary(r) },
    { key: "effective_from", label: "Effective From" },
    {
      key: "history",
      label: "",
      className: "w-32 text-right",
      render: (r) => (
        <button
          type="button"
          onClick={() => goToHistory(r)}
          className="text-sm font-medium text-primary-600 hover:text-primary-700 hover:underline"
        >
          View History
        </button>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Pricing Rules"
        description="Base rates for local, outstation, and performance billing"
        action={
          <Button onClick={() => navigate("/pricing/new")} className="bg-primary-500 hover:bg-primary-600">
            <Plus className="h-4 w-4" />
            New Rule
          </Button>
        }
      />

      <DataTable
        columns={columns}
        rows={data?.rules ?? []}
        rowKey={(r) => r.id}
        loading={isLoading}
        onRowClick={goToHistory}
        emptyMessage="No pricing rules yet"
        emptyDescription="Create your first rule to start pricing trips."
        emptyAction={
          <Button onClick={() => navigate("/pricing/new")} className="bg-primary-500 hover:bg-primary-600">
            <Plus className="h-4 w-4" />
            New Rule
          </Button>
        }
      />
    </div>
  );
}
