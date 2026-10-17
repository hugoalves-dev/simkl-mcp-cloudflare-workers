import type { SimklClient } from '../api/client.js';
import { getCurrentUserSettings, getUserStats } from '../api/user.js';
import { isRecord, jsonBytes, MAX_ROW_JSON_BYTES, type LibraryActivitySnapshot, type UserProfileActivities, type UserProfileSnapshot } from './types.js';

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
}

function validMarker(value: unknown): value is string | null {
  return value === null || validTimestamp(value);
}

function validateActivities(value: unknown): UserProfileActivities {
  if (!isRecord(value) || !validMarker(value.all)) throw new Error('Invalid Simkl activity timestamps');
  if (value.settings !== undefined && (!isRecord(value.settings) || (value.settings.all !== undefined && !validMarker(value.settings.all)))) {
    throw new Error('Invalid Simkl settings activity timestamp');
  }
  return value as UserProfileActivities;
}

function isFresh(checkedAt: number, now: number, ttlSeconds: number): boolean {
  return Number.isFinite(checkedAt) && now >= checkedAt && now - checkedAt < ttlSeconds * 1000;
}

function validCachedProfile(value: UserProfileSnapshot | undefined): value is UserProfileSnapshot {
  return !!value && value.version === 1 && validMarker(value.activities?.all)
    && Number.isFinite(value.checkedAt) && value.checkedAt >= 0
    && (value.settingsActivity === undefined || validMarker(value.settingsActivity))
    && (value.statsActivity === undefined || validMarker(value.statsActivity))
    && (value.settings === undefined || isRecord(value.settings))
    && (value.stats === undefined || isRecord(value.stats));
}

type ActivitySource = 'profile_ttl' | 'library_ttl' | 'upstream';

interface RefreshedProfile {
  snapshot: UserProfileSnapshot;
  settings: Record<string, unknown>;
  stats?: Record<string, unknown>;
  settingsRefreshed: boolean;
  activitySource: ActivitySource;
}

/** Profile and rewatch eligibility share the same settings watermark and persistent record.
 * Settings-only reads must not fetch stats or advance the stats watermark.
 */
async function refreshProfile(
  client: SimklClient,
  token: string,
  previous: UserProfileSnapshot | undefined,
  librarySnapshot: LibraryActivitySnapshot | undefined,
  options: { ttlSeconds: number; now: number },
  statsUserId?: string,
): Promise<RefreshedProfile> {
  if (previous && !validCachedProfile(previous)) throw new Error('Invalid user profile cache record');

  let activities: UserProfileActivities;
  let checkedAt: number;
  let activitySource: ActivitySource;
  if (validCachedProfile(previous) && isFresh(previous.checkedAt, options.now, options.ttlSeconds)) {
    activities = previous.activities;
    checkedAt = previous.checkedAt;
    activitySource = 'profile_ttl';
  } else if (librarySnapshot && librarySnapshot.forceCheck !== true
    && isFresh(librarySnapshot.checkedAt, options.now, options.ttlSeconds)) {
    activities = validateActivities(librarySnapshot.activities);
    checkedAt = librarySnapshot.checkedAt;
    activitySource = 'library_ttl';
  } else {
    activities = validateActivities(await client.request('/sync/activities', { method: 'GET', token }));
    checkedAt = options.now;
    activitySource = 'upstream';
  }

  if (previous && activities.all !== null && previous.activities.all !== null
    && Date.parse(activities.all) < Date.parse(previous.activities.all)) throw new Error('Simkl activity watermark regressed');

  const settingsActivityValue = isRecord(activities.settings) ? activities.settings.all : undefined;
  const settingsActivity = validMarker(settingsActivityValue) ? settingsActivityValue : undefined;
  const settingsRefreshed = !previous?.settings || previous.settingsActivity !== settingsActivity;
  const settings = settingsRefreshed ? await getCurrentUserSettings(client, token) : previous!.settings!;
  if (!isRecord(settings)) throw new Error('Invalid Simkl user settings response');

  // A settings-only read must preserve the last *fetched* stats watermark,
  // even when activities.all moved. The next stats request can then detect it.
  const refreshStats = statsUserId !== undefined && (!previous?.stats || previous.statsActivity !== activities.all);
  const stats = refreshStats ? await getUserStats(client, statsUserId!, token) : previous?.stats;
  if (statsUserId !== undefined && !isRecord(stats)) throw new Error('Invalid Simkl user statistics response');

  const snapshot: UserProfileSnapshot = {
    version: 1,
    activities,
    checkedAt,
    ...(settingsActivity === undefined ? {} : { settingsActivity }),
    settings,
    ...(stats === undefined ? {} : {
      ...(statsUserId !== undefined ? { statsActivity: activities.all } : previous?.statsActivity === undefined ? {} : { statsActivity: previous.statsActivity }),
      stats,
    }),
  };
  let serialized: string;
  try { serialized = JSON.stringify(snapshot); } catch { throw new Error('User profile cache is not serializable'); }
  if (jsonBytes(serialized) > MAX_ROW_JSON_BYTES) throw new Error('User profile cache too large');
  return { snapshot, settings, stats, settingsRefreshed, activitySource };
}

export async function refreshUserProfile(
  client: SimklClient,
  token: string,
  simklUserId: string,
  previous: UserProfileSnapshot | undefined,
  librarySnapshot: LibraryActivitySnapshot | undefined,
  options: { ttlSeconds: number; now: number },
): Promise<{ snapshot: UserProfileSnapshot; stats: Record<string, unknown> }> {
  const result = await refreshProfile(client, token, previous, librarySnapshot, options, simklUserId);
  return { snapshot: result.snapshot, stats: result.stats! };
}

export async function refreshUserSettings(
  client: SimklClient,
  token: string,
  previous: UserProfileSnapshot | undefined,
  librarySnapshot: LibraryActivitySnapshot | undefined,
  options: { ttlSeconds: number; now: number },
): Promise<Pick<RefreshedProfile, 'snapshot' | 'settings' | 'settingsRefreshed' | 'activitySource'>> {
  const { snapshot, settings, settingsRefreshed, activitySource } =
    await refreshProfile(client, token, previous, librarySnapshot, options);
  return { snapshot, settings, settingsRefreshed, activitySource };
}
