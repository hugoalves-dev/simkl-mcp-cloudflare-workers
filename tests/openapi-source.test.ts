import { describe, expect, test } from 'bun:test';
import { assertOpenApiDocument } from '../scripts/openapi-source';

describe('OpenAPI source validation', () => {
  test('accepts a populated OpenAPI 3 document', () => {
    expect(() => assertOpenApiDocument({ openapi: '3.1.0', paths: { '/movies': {} } })).not.toThrow();
  });

  test('rejects a response that is not an OpenAPI document', () => {
    expect(() => assertOpenApiDocument({ message: 'upstream unavailable' })).toThrow(/OpenAPI 3/);
  });

  test('rejects documents without paths', () => {
    expect(() => assertOpenApiDocument({ openapi: '3.1.0', paths: {} })).toThrow(/paths/);
  });
});
