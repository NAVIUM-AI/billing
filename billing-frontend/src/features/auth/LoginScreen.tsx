import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router-dom";
import { AxiosError } from "axios";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/features/auth/useAuth";
import { AUTH_ERROR_CODES } from "@/lib/errorCodes";
import { loginSchema, type LoginPayload } from "@/lib/schemas/auth";
import type { ApiErrorResponse } from "@/types/api";

export function LoginScreen() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginPayload>({ resolver: zodResolver(loginSchema) });

  async function onSubmit(payload: LoginPayload) {
    const result = await login(payload);
    if (result.success) {
      navigate("/dashboard", { replace: true });
      return;
    }

    const error = result.error;
    const code =
      error instanceof AxiosError
        ? (error.response?.data as ApiErrorResponse | undefined)?.error?.code
        : undefined;

    if (code === AUTH_ERROR_CODES.INVALID_CREDENTIALS) {
      toast.error("Invalid email or password");
    } else {
      toast.error("Something went wrong. Try again.");
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-accent-50 px-4">
      <Card className="w-full max-w-[400px] shadow-lg">
        <CardHeader>
          <h1 className="text-center text-2xl font-bold text-primary-600">
            Sign in to Navium Billing
          </h1>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                {...register("email")}
              />
              {errors.email && (
                <p className="text-xs text-destructive">{errors.email.message}</p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                {...register("password")}
              />
              {errors.password && (
                <p className="text-xs text-destructive">
                  {errors.password.message}
                </p>
              )}
            </div>
            <Button
              type="submit"
              disabled={isSubmitting}
              className="mt-2 bg-primary-500 hover:bg-primary-600"
            >
              {isSubmitting ? "Signing in..." : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
      <p className="fixed bottom-4 left-1/2 -translate-x-1/2 text-xs text-gray-500">
        Pravasi Tours &amp; Travels · Navium Billing
      </p>
    </div>
  );
}
