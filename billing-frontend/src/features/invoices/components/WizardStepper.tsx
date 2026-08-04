import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

const STEPS = [
  { n: 1, label: "Billing Type" },
  { n: 2, label: "Invoice Category" },
  { n: 3, label: "Select Trips" },
] as const;

interface WizardStepperProps {
  currentStep: 1 | 2 | 3;
}

export function WizardStepper({ currentStep }: WizardStepperProps) {
  return (
    <div className="mb-8 flex items-center">
      {STEPS.map((step, i) => {
        const isCompleted = step.n < currentStep;
        const isActive = step.n === currentStep;
        return (
          <div key={step.n} className="flex flex-1 items-center last:flex-none">
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full border-2 text-sm font-semibold",
                  isCompleted && "border-primary-500 bg-primary-500 text-white",
                  isActive && "border-primary-500 bg-white text-primary-600",
                  !isCompleted && !isActive && "border-gray-300 bg-white text-gray-400",
                )}
              >
                {isCompleted ? <Check className="h-4 w-4" /> : step.n}
              </div>
              <span
                className={cn(
                  "whitespace-nowrap text-xs font-medium",
                  isActive || isCompleted ? "text-gray-900" : "text-gray-400",
                )}
              >
                {step.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div className={cn("mx-3 h-0.5 flex-1", isCompleted ? "bg-primary-500" : "bg-gray-200")} />
            )}
          </div>
        );
      })}
    </div>
  );
}
