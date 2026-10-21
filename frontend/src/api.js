// Worker API クライアント。画面と API は同じオリジン（1つの Worker）なので相対パスで呼ぶ。
// 認証は Cookie（workers-auth のセッション。HttpOnly なので JS からは触らない）。
// 状態を変えるリクエストには __Host-csrf Cookie の値を x-csrf-token ヘッダで送り返す
// （二重送信 CSRF 対策。Worker 側の SDK が照合する）。

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.error ?? 'UNKNOWN';
    this.requestId = body?.request_id ?? null;
    this.body = body;
  }
}

const enc = encodeURIComponent;

function csrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)__Host-csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function call(path, { method = 'GET', body = undefined, raw = undefined, contentType } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (raw !== undefined && contentType) headers['content-type'] = contentType;
  if (method !== 'GET') {
    const csrf = csrfToken();
    if (csrf) headers['x-csrf-token'] = csrf;
  }

  const res = await fetch(path, {
    method,
    headers,
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// ログイン（workers-auth deviceAuth）。応答の error は SDK の固定コード
// （invalid_code / invalid_pin / email_verification_required / rate_limited など）。
export const auth = {
  emailStart: (email) => call('/auth/device/email/start', { method: 'POST', body: { email } }),
  emailVerify: (email, code) =>
    call('/auth/device/email/verify', {
      method: 'POST',
      body: { email, code, trustDevice: true, deviceLabel: navigator.userAgent.slice(0, 100) },
    }),
  setPin: (pin) => call('/auth/device/pin', { method: 'POST', body: { pin } }),
  pinStatus: () => call('/auth/device/pin/status'),
  pinLogin: (pin) => call('/auth/device/pin/login', { method: 'POST', body: { pin } }),
  logout: () => call('/auth/device/logout', { method: 'POST' }),
  forgetDevice: () => call('/auth/device/device/forget', { method: 'POST' }),
};

export const api = {
  // profiles
  register: (displayName) =>
    call('/api/profiles', { method: 'POST', body: { display_name: displayName } }),
  me: () => call('/api/me'),

  // plants
  listPlants: () => call('/api/plants'),
  createPlant: (plant) => call('/api/plants', { method: 'POST', body: plant }),
  getPlant: (id) => call(`/api/plants/${id}`),
  updatePlant: (id, patch) => call(`/api/plants/${id}`, { method: 'PATCH', body: patch }),
  deletePlant: (id) => call(`/api/plants/${id}`, { method: 'DELETE' }),
  createPhoto: (plantId, meta) =>
    call(`/api/plants/${plantId}/photos`, { method: 'POST', body: meta }),
  // createPhoto が返した upload（{ url, method, content_type }）へ画像本体を送る
  uploadPhoto: (upload, file) =>
    call(upload.url, { method: upload.method, raw: file, contentType: upload.content_type }),

  // records
  listCrossings: () => call('/api/crossings'),
  createCrossing: (crossing) => call('/api/crossings', { method: 'POST', body: crossing }),
  updateCrossing: (id, patch) => call(`/api/crossings/${id}`, { method: 'PATCH', body: patch }),
  deleteCrossing: (id) => call(`/api/crossings/${id}`, { method: 'DELETE' }),
  createHarvest: (crossingId, harvest) =>
    call(`/api/crossings/${crossingId}/harvests`, { method: 'POST', body: harvest }),
  createSowing: (harvestId, sowing) =>
    call(`/api/harvests/${harvestId}/sowings`, { method: 'POST', body: sowing }),
  updateSowing: (sowingId, patch) =>
    call(`/api/sowings/${sowingId}`, { method: 'PATCH', body: patch }),

  // lineage
  lineage: (plantId, direction = 'up', depth = 5) =>
    call(`/api/plants/${plantId}/lineage?direction=${direction}&depth=${depth}`),

  // community (Phase 2)
  // パスパラメータは必ず enc() を通す（プロフィール画面のユーザーID欄は自由入力のため、
  // `/` 等を含む値でリクエスト先パスを改変されないようにする — Opus 4.8 レビュー指摘）
  feed: ({ limit = 20, offset = 0 } = {}) => call(`/api/feed?limit=${limit}&offset=${offset}`),
  createPost: (post) => call('/api/posts', { method: 'POST', body: post }),
  getPost: (id) => call(`/api/posts/${enc(id)}`),
  listUserPosts: (userId, { limit = 20, offset = 0 } = {}) =>
    call(`/api/users/${enc(userId)}/posts?limit=${limit}&offset=${offset}`),
  likePost: (postId) => call(`/api/posts/${enc(postId)}/likes`, { method: 'POST' }),
  unlikePost: (postId) => call(`/api/posts/${enc(postId)}/likes`, { method: 'DELETE' }),
  listComments: (postId) => call(`/api/posts/${enc(postId)}/comments`),
  createComment: (postId, content) =>
    call(`/api/posts/${enc(postId)}/comments`, { method: 'POST', body: { content } }),
  follow: (followeeId) =>
    call('/api/follows', { method: 'POST', body: { followee_id: followeeId } }),
  unfollow: (followeeId) => call(`/api/follows/${enc(followeeId)}`, { method: 'DELETE' }),
  getUser: (userId) => call(`/api/users/${enc(userId)}`),
  listFollowers: (userId) => call(`/api/users/${enc(userId)}/followers`),
  listFollowing: (userId) => call(`/api/users/${enc(userId)}/following`),

  // AI (Phase 3)
  aiConsult: (message, history = []) =>
    call('/api/ai/consult', { method: 'POST', body: { message, history } }),
  aiListing: (plantId, marketplace) =>
    call('/api/ai/listing', { method: 'POST', body: { plant_id: plantId, marketplace } }),

  // 課金 (Phase 4)。Checkout Session を作成し、返る url へフロントがリダイレクトする。
  createCheckout: () => call('/api/billing/checkout', { method: 'POST' }),
  createPortal: () => call('/api/billing/portal', { method: 'POST' }),

  // 公開ページ（認証不要）
  publicPlant: (plantId) => call(`/public/plants/${plantId}`),
};
