import { describe, expect, test } from 'bun:test';
import { SimklApiError } from '../src/api/client';
import { toMcpErrorResult } from '../src/api/errors';

describe('Simkl quota errors', () => {
  test.each([
    ['rate_limit', 'Per-second rate limit reached; pause for about one second before another request.'],
    ['user_limit_exceeded', 'This user has reached the AUTH V2 daily allowance. The allowance resets at midnight New York time. Manage Connected Apps: https://simkl.com/settings/apps'],
    ['app_limit_exceeded', 'The AUTH V1 app daily allowance is exhausted. Wait for the daily reset before retrying.'],
  ])('returns actionable details for %s', (code, expected) => {
    const error = new SimklApiError('upstream failed', 429, JSON.stringify({ error: code }), {
      rateLimitLimit: '10000', rateLimitRemaining: '0', retryAfter: '3600',
    });
    const result = toMcpErrorResult(error);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(expected);
    expect(result.content[0].text).toContain('X-RateLimit-Limit: 10000');
    expect(result.content[0].text).toContain('X-RateLimit-Remaining: 0');
    expect(result.content[0].text).toContain('Retry-After: 3600 seconds');
  });

  test('treats a missing token as an authentication problem, not a quota failure', () => {
    const result = toMcpErrorResult(new SimklApiError('upstream failed', 401, '{"error":"user_token_required"}'));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('requires an AUTH V2 user access token');
    expect(result.content[0].text).not.toContain('rate limit');
  });

  test('does not invent zero values when quota headers are absent', () => {
    const result = toMcpErrorResult(new SimklApiError('upstream failed', 429, '{"error":"user_limit_exceeded"}'));
    expect(result.content[0].text).toContain('daily allowance');
    expect(result.content[0].text).not.toContain('X-RateLimit-Remaining');
    expect(result.content[0].text).not.toContain('Retry-After');
  });
});
