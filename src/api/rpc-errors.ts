import { SimklApiError, type SimklResponseHeaders } from './client.js';
import { CustomListCooldownError } from './custom-lists.js';

/**
 * Workers RPC delivers a thrown error as a plain Error whose message is
 * "<name>: <message>"; the class, name and custom fields are dropped. Encode
 * the fields callers branch on into the message and rebuild them on the other side.
 */
const MARKER = 'SIMKL_RPC_ERROR ';
const HEADER_KEYS = ['rateLimitLimit', 'rateLimitRemaining', 'retryAfter', 'lastModified'] as const;

type Payload =
  | { type: 'SimklApiError'; statusCode: number; upstreamCode: string; headers: SimklResponseHeaders; writeMayHaveSucceeded: boolean }
  | { type: 'CustomListCooldownError'; retryAfterSeconds: number };

export function encodeRpcError(error: unknown): unknown {
  let payload: Payload | undefined;
  if (error instanceof SimklApiError) {
    payload = {
      type: 'SimklApiError', statusCode: error.statusCode, upstreamCode: error.upstreamCode,
      headers: error.headers, writeMayHaveSucceeded: error.writeMayHaveSucceeded,
    };
  } else if (error instanceof CustomListCooldownError) {
    payload = { type: 'CustomListCooldownError', retryAfterSeconds: error.retryAfterSeconds };
  }
  return payload ? new Error(`${MARKER}${JSON.stringify(payload)}`) : error;
}

export function decodeRpcError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const index = error.message.indexOf(MARKER);
  if (index < 0) return error;
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(error.message.slice(index + MARKER.length)); }
  catch { return error; }

  if (payload.type === 'CustomListCooldownError') {
    const seconds = payload.retryAfterSeconds;
    return new CustomListCooldownError(Number.isSafeInteger(seconds) && (seconds as number) > 0 ? seconds as number : 60);
  }
  const status = payload.statusCode;
  if (payload.type !== 'SimklApiError' || typeof status !== 'number' || !Number.isInteger(status)
    || !(status === 0 || (status >= 100 && status <= 599))) return error;
  const headers: SimklResponseHeaders = {};
  const rawHeaders = payload.headers && typeof payload.headers === 'object' ? payload.headers as Record<string, unknown> : {};
  for (const key of HEADER_KEYS) if (typeof rawHeaders[key] === 'string') headers[key] = rawHeaders[key] as string;
  const code = typeof payload.upstreamCode === 'string' ? payload.upstreamCode : '';
  return new SimklApiError(`simkl api error: ${status}`, status, JSON.stringify({ error: code }), headers, payload.writeMayHaveSucceeded === true);
}
