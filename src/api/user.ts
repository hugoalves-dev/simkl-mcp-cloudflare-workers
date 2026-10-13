import type { SimklClient } from './client.js';

export function getCurrentUserSettings(client: SimklClient, token: string): Promise<any> {
  return client.request('/users/settings', { method: 'GET', token });
}

export async function getUserStats(client: SimklClient, userId: number | string, token: string): Promise<any> {
  let id: string;
  if (typeof userId === 'number') {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('Invalid Simkl user ID');
    id = String(userId);
  } else if (typeof userId === 'string' && /^\d+$/.test(userId)) {
    id = userId.replace(/^0+/, '');
    if (!id) throw new Error('Invalid Simkl user ID');
  } else {
    throw new Error('Invalid Simkl user ID');
  }
  return client.request(`/users/${id}/stats`, { method: 'GET', token });
}
