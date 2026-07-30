import { useNavigate, useParams } from "react-router-dom";

import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { usePricingRuleHistory } from "@/features/pricingRules/pricingRules.hooks";
import { formatRuleSummary } from "@/features/pricingRules/ruleSummary";
import type { RuleType, VehicleType } from "@/lib/constants/enums";
import { RULE_TYPE_LABELS, VEHICLE_TYPE_LABELS } from "@/lib/constants/enums";
import type { PricingRule } from "@/types/pricingRule";

export function PricingRuleDetailPage() {
  const { ruleType, vehicleType } = useParams<{ ruleType: string; vehicleType: string }>();
  const navigate = useNavigate();
  const { data, isLoading } = usePricingRuleHistory(ruleType as RuleType, vehicleType as VehicleType);

  const rules = data?.rules ?? [];
  // effective_to === null is ALWAYS the current version (ADR-005's
  // exclusion constraint guarantees at most one such row per combo) —
  // never assumed from list ORDER, even though the backend happens to
  // return effective_from DESC (current usually sorts first in
  // practice, but "usually" isn't a guarantee worth depending on).
  const current = rules.find((r) => r.effective_to === null);
  const history = rules.filter((r) => r.id !== current?.id);

  const label = `${RULE_TYPE_LABELS[ruleType as RuleType] ?? ruleType} — ${VEHICLE_TYPE_LABELS[vehicleType as VehicleType] ?? vehicleType}`;

  if (isLoading) {
    return <p className="text-sm text-gray-500">Loading...</p>;
  }

  if (!current) {
    return (
      <div>
        <PageHeader title={label} />
        <EmptyState
          title="No active rule for this combination"
          description="Create a rule to start pricing trips with this service type and vehicle."
          action={
            <Button onClick={() => navigate("/pricing/new")} className="bg-primary-500 hover:bg-primary-600">
              New Rule
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={label}
        description="Current rate + full version history"
        action={
          <Button
            onClick={() => navigate(`/pricing/${current.id}/new-version`)}
            className="bg-primary-500 hover:bg-primary-600"
          >
            + New Version
          </Button>
        }
      />

      <div className="mb-8 rounded-lg border-2 border-primary-200 bg-primary-50 p-5">
        <div className="mb-1 flex items-center gap-2">
          <span className="rounded bg-primary-600 px-2 py-0.5 text-xs font-semibold text-white">CURRENT</span>
          <span className="text-sm text-gray-500">Effective from {current.effective_from}</span>
        </div>
        <p className="text-lg font-semibold text-gray-900">{current.label}</p>
        <p className="mt-1 text-sm text-gray-700">{formatRuleSummary(current)}</p>
        {current.notes && <p className="mt-2 text-sm text-gray-500">{current.notes}</p>}
      </div>

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Version History</h2>
      {history.length === 0 ? (
        <p className="text-sm text-gray-500">No history yet — this is the only version.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {history.map((rule) => (
            <SupersededCard key={rule.id} rule={rule} />
          ))}
        </div>
      )}
    </div>
  );
}

// Deliberately no menu, no pencil icon, no click handler anywhere on
// this card — ADR-005's whole point is that a superseded rule's rate
// is never editable again, so there is no affordance here to remove or
// disable. There's simply nothing to click.
function SupersededCard({ rule }: { rule: PricingRule }) {
  return (
    <div className="rounded-lg border bg-gray-50 p-4">
      <div className="mb-1 flex items-center gap-2">
        <span className="rounded bg-gray-400 px-2 py-0.5 text-xs font-semibold text-white">SUPERSEDED</span>
        <span className="text-sm text-gray-500">
          {rule.effective_from} &rarr; {rule.effective_to}
        </span>
      </div>
      <p className="font-medium text-gray-700">{rule.label}</p>
      <p className="mt-1 text-sm text-gray-600">{formatRuleSummary(rule)}</p>
    </div>
  );
}
