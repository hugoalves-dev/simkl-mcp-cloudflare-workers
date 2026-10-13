import type { SimklClient } from '../api/client.js';
import { getCurrentUserSettings, getUserStats } from '../api/user.js';
import { isRecord, jsonBytes, MAX_ROW_JSON_BYTES, type Activities, type LibrarySnapshot, type UserProfileSnapshot } from './types.js';

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
}

function validateActivities(value: unknown): Activities {
  if (!isRecord(value) || !validTimestamp(value.all)) throw new Error('Invalid Simkl activity timestamps');
  if (value.settings !== undefined && (!isRecord(value.settings) || (value.settings.all !== undefined && !validTimestamp(value.settings.all)))) {
    throw new Error('Invalid Simkl settings activity timestamp');
  }
  return value as Activities;
}

function isFresh(checkedAt: number, now: number, ttlSeconds: number): boolean {
  return Number.isFinite(checkedAt) && now >= checkedAt && now - checkedAt < ttlSeconds * 1000;
}

function validCachedProfile(value: UserProfileSnapshot | undefined): value is UserProfileSnapshot {
  return !!value && value.version === 1 && validTimestamp(value.activities?.all)
    && Number.isFinite(value.checkedAt) && value.checkedAt >= 0
    && (value.settingsActivity === undefined || validTimestamp(value.settingsActivity))
    && (value.statsActivity === undefined || validTimestamp(value.statsActivity))
    && (value.settings === undefined || isRecord(value.settings))
    && (value.stats === undefined || isRecord(value.stats));
}

export async function refreshUserProfile(
  client: SimklClient,
  token: string,
  simklUserId: string,
  previous: UserProfileSnapshot | undefined,
  librarySnapshot: LibrarySnapshot | undefined,
  options: { ttlSeconds: number; now: number },
): Promise<{ snapshot: UserProfileSnapshot; stats: Record<string, unknown> }> {
  if (previous && !validCachedProfile(previous)) throw new Error('Invalid user profile cache record');

  let activities: Activities;
  let checkedAt: number;
  if (validCachedProfile(previous) && isFresh(previous.checkedAt, options.now, options.ttlSeconds)) {
    activities = previous.activities;
    checkedAt = previous.checkedAt;
  } else if (librarySnapshot?.version === 1 && librarySnapshot.forceCheck !== true
    && isFresh(librarySnapshot.checkedAt, options.now, options.ttlSeconds)) {
    activities = validateActivities(librarySnapshot.activities);
    checkedAt = librarySnapshot.checkedAt;
  } else {
    activities = validateActivities(await client.request('/sync/activities', { method: 'GET', token }));
    if (previous && Date.parse(activities.all) < Date.parse(previous.activities.all)) throw new Error('Simkl activity watermark regressed');
    checkedAt = options.now;
  }

  const settingsActivityValue = isRecord(activities.settings) ? activities.settings.all : undefined;
  const settingsActivity = validTimestamp(settingsActivityValue) ? settingsActivityValue : undefined;
  const statsActivity = activities.all;
  const refreshSettings = !previous?.settings || !settingsActivity || previous.settingsActivity !== settingsActivity;
  const refreshStats = !previous?.stats || previous.statsActivity !== statsActivity;

  const settings = refreshSettings ? await getCurrentUserSettings(client, token) : previous!.settings!;
  if (!isRecord(settings)) throw new Error('Invalid Simkl user settings response');
  const stats = refreshStats ? await getUserStats(client, simklUserId, token) : previous!.stats!;
  if (!isRecord(stats)) throw new Error('Invalid Simkl user statistics response');

  const snapshot: UserProfileSnapshot = {
    version: 1,
    activities,
    checkedAt,
    ...(settingsActivity === undefined ? {} : { settingsActivity }),
    settings,
    statsActivity,
    stats,
  };
  let serialized: string;
  try { serialized = JSON.stringify(snapshot); } catch { throw new Error('User profile cache is not serializable'); }
  if (jsonBytes(serialized) > MAX_ROW_JSON_BYTES) throw new Error('User profile cache too large');
  return { snapshot, stats };
}
