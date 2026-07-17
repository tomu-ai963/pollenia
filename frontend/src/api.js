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

const enc = encodeURIComponent;

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
  updateCrossing: (token, id, patch) =>
    call(`/api/crossings/${id}`, { method: 'PATCH', token, body: patch }),
  deleteCrossing: (token, id) => call(`/api/crossings/${id}`, { method: 'DELETE', token }),
  createHarvest: (token, crossingId, harvest) =>
    call(`/api/crossings/${crossingId}/harvests`, { method: 'POST', token, body: harvest }),
  createSowing: (token, harvestId, sowing) =>
    call(`/api/harvests/${harvestId}/sowings`, { method: 'POST', token, body: sowing }),
  updateSowing: (token, sowingId, patch) =>
    call(`/api/sowings/${sowingId}`, { method: 'PATCH', token, body: patch }),

  // lineage
  lineage: (token, plantId, direction = 'up', depth = 5) =>
    call(`/api/plants/${plantId}/lineage?direction=${direction}&depth=${depth}`, { token }),

  // community (Phase 2)
  // パスパラメータは必ず enc() を通す（プロフィール画面のユーザーID欄は自由入力のため、
  // `/` 等を含む値でリクエスト先パスを改変されないようにする — Opus 4.8 レビュー指摘）
  feed: (token, { limit = 20, offset = 0 } = {}) =>
    call(`/api/feed?limit=${limit}&offset=${offset}`, { token }),
  createPost: (token, post) => call('/api/posts', { method: 'POST', token, body: post }),
  getPost: (token, id) => call(`/api/posts/${enc(id)}`, { token }),
  listUserPosts: (token, userId, { limit = 20, offset = 0 } = {}) =>
    call(`/api/users/${enc(userId)}/posts?limit=${limit}&offset=${offset}`, { token }),
  likePost: (token, postId) => call(`/api/posts/${enc(postId)}/likes`, { method: 'POST', token }),
  unlikePost: (token, postId) =>
    call(`/api/posts/${enc(postId)}/likes`, { method: 'DELETE', token }),
  listComments: (token, postId) => call(`/api/posts/${enc(postId)}/comments`, { token }),
  createComment: (token, postId, content) =>
    call(`/api/posts/${enc(postId)}/comments`, { method: 'POST', token, body: { content } }),
  follow: (token, followeeId) =>
    call('/api/follows', { method: 'POST', token, body: { followee_id: followeeId } }),
  unfollow: (token, followeeId) =>
    call(`/api/follows/${enc(followeeId)}`, { method: 'DELETE', token }),
  getUser: (token, userId) => call(`/api/users/${enc(userId)}`, { token }),
  listFollowers: (token, userId) => call(`/api/users/${enc(userId)}/followers`, { token }),
  listFollowing: (token, userId) => call(`/api/users/${enc(userId)}/following`, { token }),

  // AI (Phase 3)
  aiConsult: (token, message, history = []) =>
    call('/api/ai/consult', { method: 'POST', token, body: { message, history } }),
  aiListing: (token, plantId, marketplace) =>
    call('/api/ai/listing', { method: 'POST', token, body: { plant_id: plantId, marketplace } }),

  // 課金 (Phase 4)。Checkout Session を作成し、返る url へフロントがリダイレクトする。
  createCheckout: (token) => call('/api/billing/checkout', { method: 'POST', token }),
  createPortal: (token) => call('/api/billing/portal', { method: 'POST', token }),

  // 公開ページ（認証不要）
  publicPlant: (plantId) => call(`/public/plants/${plantId}`),
};
