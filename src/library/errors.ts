export class LibraryWriteInvalidationError extends Error {
  constructor() {
    super('Upstream write succeeded, but library cache invalidation failed');
    this.name = 'LibraryWriteInvalidationError';
  }
}


/** Exhausted all documented, lossless Simkl sync partitions. Safe across Worker RPC. */
export class LibrarySyncLimitError extends Error {
  readonly code = 'SIMKL_SYNC_PARTITION_EXHAUSTED';
  constructor(
    readonly phase: 'initial' | 'incremental',
    readonly operation: 'baseline' | 'delta' | 'ratings' | 'membership',
    readonly media: 'shows' | 'movies' | 'anime',
    readonly status?: string,
  ) {
    super(`Simkl max_items cannot be recovered: ${phase} ${operation} ${media}${status ? `/${status}` : ''}. No documented lossless partition remains; the previous library snapshot was preserved. Contact Simkl maintainers via https://support.simkl.com/ or https://api.simkl.org/guides/sync with this partition and the max_items response code.`);
    this.name = 'LibrarySyncLimitError';
  }
}
