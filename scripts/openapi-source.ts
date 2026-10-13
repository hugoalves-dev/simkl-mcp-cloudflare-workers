export interface OpenApiDocument {
  openapi?: unknown;
  paths?: unknown;
}

export function assertOpenApiDocument(document: OpenApiDocument): asserts document is OpenApiDocument & {
  openapi: string;
  paths: Record<string, unknown>;
} {
  if (typeof document.openapi !== 'string' || !document.openapi.startsWith('3.')) {
    throw new Error('Expected an OpenAPI 3 document');
  }

  if (!document.paths || typeof document.paths !== 'object' || Array.isArray(document.paths)
    || Object.keys(document.paths).length === 0) {
    throw new Error('Expected an OpenAPI document with non-empty paths');
  }
}
