// Mirrors errorHandler.js's global envelope: every error response is
// `{ error: { code, message, details? } }`, never a bare message string.
export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ApiErrorResponse {
  error: ApiError;
}
