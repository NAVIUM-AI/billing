import { useAuth } from "@/features/auth/useAuth";

export function DashboardPlaceholder() {
  const { user } = useAuth();

  return (
    <div className="p-8">
      <h1 className="text-2xl font-semibold text-primary-700">
        Hello, {user?.full_name}
      </h1>
      <p className="mt-2 text-gray-600">Dashboard content coming in Task F5.</p>
    </div>
  );
}
