import { apiFetch } from './client';

export async function getSettings(keys = []) {
  const query = new URLSearchParams();
  for (const key of keys) {
    if (key) query.append('key', String(key));
  }
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const data = await apiFetch(`/api/settings${suffix}`);
  return data.settings || {};
}

export async function updateSettings(settings, removeKeys = []) {
  const data = await apiFetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings, removeKeys }),
  });
  return data.settings || {};
}

export async function deleteSettings(keys = []) {
  const data = await apiFetch('/api/settings', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys }),
  });
  return data.settings || {};
}
