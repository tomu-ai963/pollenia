// Worker API クライアント。認証トークンは呼び出し側（app.js の Supabase セッション）から受け取る。
import { CONFIG } from './config.js';

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.error ?? 'UNKNOWN';
    this.requestId = body?.request_id ?? null;
  }
}

async function call(path, { method = 'GET', token = null, body = undefined } = {}) {
  const headers = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(`${CONFIG.WORKER_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const api = {
  // profiles
  register: (token, displayName) =>
    call('/api/profiles', { method: 'POST', token, body: { display_name: displayName } }),
  me: (token) => call('/api/me', { token }),

  // plants
  listPlants: (token) => call('/api/plants', { token }),
  createPlant: (token, plant) => call('/api/plants', { method: 'POST', token, body: plant }),
  getPlant: (token, id) => call(`/api/plants/${id}`, { token }),
  updatePlant: (token, id, patch) =>
    call(`/api/plants/${id}`, { method: 'PATCH', token, body: patch }),
  deletePlant: (token, id) => call(`/api/plants/${id}`, { method: 'DELETE', token }),
  createPhoto: (token, plantId, meta) =>
    call(`/api/plants/${plantId}/photos`, { method: 'POST', token, body: meta }),

  // records
  listCrossings: (token) => call('/api/crossings', { token }),
  createCrossing: (token, crossing) =>
    call('/api/crossings', { method: 'POST', token, body: crossing }),
  createHarvest: (token, crossingId, harvest) =>
    call(`/api/crossings/${crossingId}/harvests`, { method: 'POST', token, body: harvest }),
  createSowing: (token, harvestId, sowing) =>
    call(`/api/harvests/${harvestId}/sowings`, { method: 'POST', token, body: sowing }),
  updateSowing: (token, sowingId, patch) =>
    call(`/api/sowings/${sowingId}`, { method: 'PATCH', token, body: patch }),

  // lineage
  lineage: (token, plantId, direction = 'up', depth = 5) =>
    call(`/api/plants/${plantId}/lineage?direction=${direction}&depth=${depth}`, { token }),

  // 公開ページ（認証不要）
  publicPlant: (plantId) => call(`/public/plants/${plantId}`),
};
