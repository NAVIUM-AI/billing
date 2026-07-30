import { Search, X } from "lucide-react";
import { useEffect, useState } from "react";

import { useDebounce } from "@/hooks/useDebounce";
import { cn } from "@/lib/utils";

interface SearchInputProps {
  placeholder?: string;
  onDebouncedChange: (value: string) => void;
  debounceMs?: number;
  className?: string;
}

// Uncontrolled from the parent's perspective — parent only ever
// receives the debounced value via onDebouncedChange, never every
// keystroke. Internal `value` state keeps the input itself instantly
// responsive.
export function SearchInput({
  placeholder = "Search...",
  onDebouncedChange,
  debounceMs = 300,
  className,
}: SearchInputProps) {
  const [value, setValue] = useState("");
  const debounced = useDebounce(value, debounceMs);

  useEffect(() => {
    onDebouncedChange(debounced);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        className="h-9 w-full rounded-md border border-input bg-transparent py-1 pl-8 pr-8 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      {value && (
        <button
          type="button"
          onClick={() => setValue("")}
          aria-label="Clear search"
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
