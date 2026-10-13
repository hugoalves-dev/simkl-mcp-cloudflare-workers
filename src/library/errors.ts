export class LibraryWriteInvalidationError extends Error {
  constructor() {
    super('Upstream write succeeded, but library cache invalidation failed');
    this.name = 'LibraryWriteInvalidationError';
  }
}

