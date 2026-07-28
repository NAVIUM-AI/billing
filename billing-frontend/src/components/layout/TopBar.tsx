import { useEffect, useRef, useState } from "react";
import { ChevronDown, LogOut } from "lucide-react";

import { useAuth } from "@/features/auth/useAuth";
import { cn } from "@/lib/utils";

// A dedicated dropdown-menu primitive isn't part of Task F1's narrow
// shadcn install (button/input/label/card/sonner only) — this is a
// small self-contained menu rather than pulling in @radix-ui/react-
// dropdown-menu for the one "Sign out" action. If a second dropdown
// use case shows up in F2+, promoting this to a real primitive is the
// right call then, not preemptively here.
export function TopBar() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <header className="flex h-14 shrink-0 items-center justify-end border-b bg-white px-6">
      <div className="relative" ref={menuRef}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent-50"
        >
          <span className="font-medium text-gray-900">{user?.full_name}</span>
          <span className="rounded-full bg-primary-50 px-2 py-0.5 text-xs font-medium capitalize text-primary-700">
            {user?.role}
          </span>
          <ChevronDown className="h-4 w-4 text-gray-500" />
        </button>
        <div
          className={cn(
            "absolute right-0 top-full z-10 mt-1 w-40 rounded-md border bg-white py-1 shadow-md",
            open ? "block" : "hidden",
          )}
        >
          <button
            type="button"
            onClick={() => void logout()}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-accent-50"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
