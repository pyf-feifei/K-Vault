import { apiFetch } from './client';

export async function getCacheStatus() {
  const data = await apiFetch('/api/cache/status');
  return data.status || {};
}

export async function getCacheEntries(limit = 100) {
  const data = await apiFetch(`/api/cache/entries?limit=${encodeURIComponent(String(limit))}`);
  return data.items || [];
}

export async function cleanupCache() {
  const data = await apiFetch('/api/cache/cleanup', {
    method: 'POST',
  });
  return data.status || {};
}

export async function clearCache() {
  const data = await apiFetch('/api/cache', {
    method: 'DELETE',
  });
  return {
    deleted: data.deleted || 0,
    status: data.status || {},
  };
}
