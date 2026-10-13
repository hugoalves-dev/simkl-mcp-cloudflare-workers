export type MediaType = 'shows' | 'movies' | 'anime';

export interface LibraryItemRow {
  mediaType: MediaType;
  simklId: string;
  itemJson: string;
}

export interface LibraryCandidate {
  activities: Record<string, unknown>;
  items: LibraryItemRow[];
}

export interface LibraryInitialization {
  initialized: true;
  itemCount: number;
}

export const MEDIA_TYPES: readonly MediaType[] = ['shows', 'movies', 'anime'];
export const LIBRARY_STATUSES = ['watching', 'plantowatch', 'hold', 'completed', 'dropped'] as const;
export const STATUSES_BY_MEDIA: Record<MediaType, readonly string[]> = {
  shows: LIBRARY_STATUSES,
  anime: LIBRARY_STATUSES,
  movies: ['plantowatch', 'completed', 'dropped'],
};
export const MAX_ROW_JSON_BYTES = 1024 * 1024;
export const MAX_PENDING_ITEM_BYTES = 32 * 1024 * 1024;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function jsonBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export interface MediaMetadata { ids: { simkl: number | string; [key: string]: unknown }; title?: string; [key: string]: unknown }
export interface LibraryItem {
  status?: string;
  show?: MediaMetadata;
  movie?: MediaMetadata;
  anime?: MediaMetadata;
  user_rating?: number | null;
  [key: string]: unknown;
}
export type LibraryItems = Record<MediaType, LibraryItem[]>;
export interface Activities { all: string; tv_shows?: Record<string, string | null>; movies?: Record<string, string | null>; anime?: Record<string, string | null>; [key: string]: unknown }
export interface LibrarySnapshot { version: 1; items: LibraryItems; activities: Activities; checkedAt: number; forceCheck: boolean }
export interface LibraryActivitySnapshot { activities: Activities; checkedAt: number; forceCheck: boolean }
export interface UserProfileActivities { all: string | null; settings?: Record<string, unknown>; [key: string]: unknown }
export interface UserProfileSnapshot {
  version: 1;
  activities: UserProfileActivities;
  checkedAt: number;
  settingsActivity?: string | null;
  settings?: Record<string, unknown>;
  statsActivity?: string | null;
  stats?: Record<string, unknown>;
}
