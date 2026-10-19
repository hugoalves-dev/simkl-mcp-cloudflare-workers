import { SimklApiError } from './client.js';
import { SimklGenreInputError } from './trending.js';

interface McpErrorResult {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
}

export function toMcpErrorResult(error: unknown): McpErrorResult {
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
