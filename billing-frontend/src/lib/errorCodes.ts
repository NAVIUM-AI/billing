/**
 * Literal error `code` strings the backend actually returns (grepped
 * from auth.service.js / middleware/authenticate.js — see git blame on
 * this file for the exact source lines checked at the time). Centralized
 * here so the axios interceptor and any feature-level error handling
 * reference one source instead of re-typing string literals that can
 * drift from what the backend actually sends.
 */
export const AUTH_ERROR_CODES = {
  // POST /auth/login — wrong email, wrong password, or inactive user
  // all map to this ONE code (deliberate, avoids email enumeration).
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",

  // Protected-route middleware (src/middleware/authenticate.js):
  // three DISTINCT codes depending on exactly what's wrong with the
  // access token.
  AUTH_REQUIRED: "AUTH_REQUIRED", // no/malformed Authorization header
  ACCESS_TOKEN_EXPIRED: "ACCESS_TOKEN_EXPIRED", // expired — the ONLY code that should trigger a silent refresh+retry
  AUTH_INVALID: "AUTH_INVALID", // malformed/invalid signature, or user gone

  // POST /auth/refresh
  REFRESH_TOKEN_MISSING: "REFRESH_TOKEN_MISSING", // no refresh_token cookie at all
  REFRESH_TOKEN_REUSED: "REFRESH_TOKEN_REUSED", // theft signal — ALL of the user's tokens get revoked server-side
  REFRESH_TOKEN_INVALID: "REFRESH_TOKEN_INVALID", // expired or never issued
} as const;
