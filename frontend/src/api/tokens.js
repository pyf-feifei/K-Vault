import { apiFetch } from './client';

export async function listApiTokens() {
  const data = await apiFetch('/api/tokens');
  return {
    tokens: data.tokens || [],
    scopes: data.scopes || [],
  };
}

export async function createApiToken(payload) {
  return apiFetch('/api/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function updateApiToken(id, payload) {
  return apiFetch(`/api/tokens/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function deleteApiToken(id) {
  return apiFetch(`/api/tokens/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function rotateApiToken(id) {
  return apiFetch(`/api/tokens/${encodeURIComponent(id)}/rotate`, {
    method: 'POST',
  });
}
