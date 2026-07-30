import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input:not([disabled]), select, [tabindex]:not([tabindex="-1"])';

// Hand-written (not shadcn — narrow-install constraint from F1). Slides
// in from the right, traps focus, closes on Esc/backdrop click. Stays
// mounted for ~200ms after `open` flips false so the slide-out
// transition can finish instead of the panel just vanishing.
export function Drawer({ open, onOpenChange, title, children, footer }: DrawerProps) {
  const [mounted, setMounted] = useState(open);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (mounted) {
      const timer = setTimeout(() => setMounted(false), 200);
      return () => clearTimeout(timer);
    }
  }, [open, mounted]);

  useEffect(() => {
    // `mounted` (not just `open`) is a real dependency here, not
    // decorative: `open` flips true one render BEFORE `mounted` does
    // (mounted is set via the OTHER effect above), so on that first
    // render the portal content — and panelRef.current — doesn't exist
    // yet. Without `mounted` in the deps, this effect's one-shot
    // `panelRef.current?.focus()` silently no-ops on a null ref and
    // never gets a second chance to run, leaving focus (and therefore
    // the Tab trap, which starts from wherever focus already is)
    // outside the drawer entirely. Caught by actually driving Tab/Esc
    // in a real browser, not by reading the code.
    if (!open || !mounted) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onOpenChange(false);
        return;
      }
      if (e.key === "Tab") {
        const focusable = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
        if (!focusable || focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [open, mounted, onOpenChange]);

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div
        className={cn(
          "absolute inset-0 bg-black/40 transition-opacity duration-200",
          open ? "opacity-100" : "opacity-0",
        )}
        onClick={() => onOpenChange(false)}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          "absolute right-0 top-0 flex h-full w-[500px] max-w-full flex-col bg-white shadow-xl outline-none transition-transform duration-200 ease-out",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 id={titleId} className="text-lg font-semibold text-gray-900">
            {title}
          </h2>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="border-t px-5 py-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
