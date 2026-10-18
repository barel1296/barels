/**
 * Platform API error. `code` values are stable and documented in
 * apps/platform/README.md (platform error codes); HTTP status follows the code.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Missing or invalid credentials') =>
  new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message: string, details?: Record<string, unknown>) =>
  new AppError(403, 'FORBIDDEN', message, details);
export const notFound = (what: string, id?: string) =>
  new AppError(404, 'NOT_FOUND', `${what} not found`, id ? { id } : undefined);
export const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(422, code, message, details);

/** Postgres error codes the services translate into API errors. */
export const PG = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  raiseException: 'P0001',
} as const;

export function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}
