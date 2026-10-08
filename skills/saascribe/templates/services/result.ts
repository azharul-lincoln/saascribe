/**
 * What every service returns: an HTTP status and a JSON body. The HTTP adapter sends it as is.
 * Errors carry a stable `code` the frontend branches on, and an `error` sentence it may show.
 */
export interface ServiceResult {
  status: number;
  body: Record<string, unknown>;
}

export const ok = (body: Record<string, unknown>, status = 200): ServiceResult => ({ status, body });

export const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): ServiceResult => ({
  status,
  body: { code, error, ...extra },
});

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
