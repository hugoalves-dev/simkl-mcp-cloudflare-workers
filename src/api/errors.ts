import { SimklApiError } from './client.js';
import { SimklGenreInputError } from './trending.js';
import { LibrarySyncLimitError, SimklAuthRequiredError } from '../library/errors.js';

interface McpErrorResult {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
}

const MISSING_USER_TOKEN_MESSAGE = 'This Simkl tool requires an AUTH V2 user access token, and none is available for this session. Connect your Simkl account and retry; no request was sent to Simkl.';

/** Protected AUTH V2 endpoints fail locally, before any shared cache lookup or upstream request. */
export function missingUserTokenResult(): McpErrorResult {
  return { isError: true, content: [{ type: 'text', text: MISSING_USER_TOKEN_MESSAGE }] };
}

/** Local input validation failures whose messages are safe to show verbatim. */
export class SimklInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimklInputError';
  }
}

export function toMcpErrorResult(error: unknown): McpErrorResult {
  if (error instanceof SimklAuthRequiredError) return missingUserTokenResult();
  if (error instanceof SimklInputError) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
  if (error instanceof LibrarySyncLimitError) {
    return { isError: true, content: [{ type: 'text', text: `SIMKL_SYNC_PARTITION_EXHAUSTED: ${error.message}` }] };
  }
  if (error instanceof SimklGenreInputError) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
  if (!(error instanceof SimklApiError)) {
    return { isError: true, content: [{ type: 'text', text: 'Simkl request failed. Check the inputs and try again.' }] };
  }

  const upstreamCode = error.upstreamCode;

  let message: string;
  if (error.writeMayHaveSucceeded) {
    message = 'The Simkl write may have succeeded despite the upstream failure. Inspect history and rewatch sessions before retrying to avoid duplicate changes.';
  } else if (error.statusCode === 400 && upstreamCode === 'write_lock') {
    message = 'Another Simkl write is still running for this user. Writes must be serialized; retry shortly after the lock clears.';
  } else if (error.statusCode === 429 && upstreamCode === 'rate_limit') {
    message = 'Per-second rate limit reached; pause for about one second before another request.';
  } else if (error.statusCode === 429 && upstreamCode === 'user_limit_exceeded') {
    message = 'This user has reached the AUTH V2 daily allowance. The allowance resets at midnight New York time. Manage Connected Apps: https://simkl.com/settings/apps';
  } else if (error.statusCode === 429 && upstreamCode === 'app_limit_exceeded') {
    message = 'The AUTH V1 app daily allowance is exhausted. Wait for the daily reset before retrying.';
  } else if (error.statusCode === 401 && upstreamCode === 'user_token_required') {
    message = 'This Simkl endpoint requires an AUTH V2 user access token. Authenticate with Simkl and retry.';
  } else if (error.statusCode === 401 && upstreamCode === 'invalid_token') {
    message = 'The Simkl access token expired or was revoked. Reconnect your Simkl account and retry.';
  } else if (error.statusCode === 403 && upstreamCode === 'oauth2_token_required') {
    message = 'This Simkl endpoint requires an AUTH V2 (OAuth 2) token; an AUTH V1 token was sent. Reconnect your Simkl account and retry.';
  } else if (error.statusCode === 403 && upstreamCode === 'insufficient_scope') {
    message = 'The Simkl access token lacks the media:write scope required for this change. Reconnect your Simkl account and grant write access.';
  } else if (error.statusCode > 0) {
    message = `Simkl request failed with HTTP ${error.statusCode}. Check the inputs and try again.`;
  } else {
    message = 'Simkl request failed. Check the inputs and try again.';
  }

  const details: string[] = [];
  if (error.headers.rateLimitLimit !== undefined) details.push(`X-RateLimit-Limit: ${error.headers.rateLimitLimit}`);
  if (error.headers.rateLimitRemaining !== undefined) details.push(`X-RateLimit-Remaining: ${error.headers.rateLimitRemaining}`);
  if (error.headers.retryAfter !== undefined) {
    const note = upstreamCode === 'rate_limit' ? ' (daily reset header; ignore for this short burst limit)' : '';
    details.push(`Retry-After: ${error.headers.retryAfter} seconds${note}`);
  }
  if (details.length > 0) message += `\n${details.join('\n')}`;
  return { isError: true, content: [{ type: 'text', text: message }] };
}
