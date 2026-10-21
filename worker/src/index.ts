import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { getUser } from '@tomu-ai/workers-auth';
import type { Env } from './env';
import { json } from './lib/http';
import { errorResponse } from './lib/error-response';
import { createDb, type Sql } from './lib/db';
import {
  AuthConfigError,
  authenticateUser,
  buildAuth,
  type AuthContext,
  type AuthedUser,
} from './lib/auth';
import { createPhotoSigner, handleGetPhoto, type PhotoSigner } from './lib/photos';
import { handleCreateProfile, handleGetMe } from './routes/profiles';
import {
  handleCreatePhoto,
  handleCreatePlant,
  handleDeletePlant,
  handleGetPlant,
  handleListPlants,
  handleUpdatePlant,
  handleUploadPhoto,
} from './routes/plants';
import {
  handleCreateCrossing,
  handleCreateHarvest,
  handleCreateSowing,
  handleDeleteCrossing,
  handleListCrossings,
  handleUpdateCrossing,
  handleUpdateSowing,
} from './routes/records';
import { handleGetLineage } from './routes/lineage';
import { handlePublicPlant } from './routes/public';
import {
  handleCreateComment,
  handleCreateLike,
  handleDeleteLike,
  handleFeed,
  handleGetPost,
  handleListComments,
  handleListUserPosts,
  handleCreatePost,
} from './routes/posts';
import {
  handleCreateFollow,
  handleDeleteFollow,
  handleGetUserProfile,
  handleListFollowers,
  handleListFollowing,
} from './routes/follows';
import { handleAiConsult, handleAiListing } from './routes/ai';
import { handleCreateCheckout, handleCreatePortal, handleStripeWebhook } from './routes/billing';

// 1つの Worker で画面（frontend/ の静的配信。wrangler.toml の [assets]）と API を配信する。
// 静的ファイルに一致したパスは Worker を通らずに返り、それ以外がここに来る。
//
//   認証不要
//     - GET  /api/health                … ヘルスチェック
//     - GET  /public/plants/:id         … 公開系統ページの API（p_viewer=null で RPC）
//     - GET  /photos/:token             … 写真（Worker が署名した URL のみ。lib/photos.ts）
//     - POST /api/billing/webhook       … Stripe Webhook（署名で真正性を担保）
//   ログイン（workers-auth deviceAuth。lib/auth.ts）
//     - /auth/device/*                  … メールコード・PIN・信頼済み端末・ログアウト
//   セッションのみ（profiles 行を要求しない）
//     - POST /api/profiles              … Pollenia への初回登録
//   セッション + profiles 行（有効なセッション ≠ Pollenia ユーザー）
//     - GET  /api/me
//     - GET/POST /api/plants、GET/PATCH/DELETE /api/plants/:id
//     - POST /api/plants/:id/photos     … 写真行の作成（アップロード先を返す）
//     - PUT  /api/photos/:id            … 写真本体のアップロード（R2）
//     - GET/POST /api/crossings、PATCH/DELETE /api/crossings/:id、POST /api/crossings/:id/harvests
//     - POST /api/harvests/:id/sowings、PATCH /api/sowings/:id
//     - GET  /api/plants/:id/lineage?direction=up|down&depth=N
//   Phase 2（コミュニティ）
//     - POST /api/posts、GET /api/posts/:id、GET /api/feed
//     - POST/DELETE /api/posts/:id/likes、GET/POST /api/posts/:id/comments
//     - POST /api/follows、DELETE /api/follows/:followee_id
//     - GET  /api/users/:id、/api/users/:id/posts、/followers、/following
//   Phase 3（AI。有料ゲート = active/past_due のみ許可）
//     - POST /api/ai/consult、POST /api/ai/listing
//   Phase 4（課金。Stripe 月額サブスク ¥300/月）
//     - POST /api/billing/checkout、POST /api/billing/portal
//
// 状態を変えるメソッド（POST/PUT/PATCH/DELETE）は workers-auth の middleware が Origin と
// CSRF 二重送信トークン（__Host-csrf Cookie ↔ x-csrf-token ヘッダ）を確かめる。

type Vars = { sql: Sql; authCtx: AuthContext };
type AppEnv = { Bindings: Env; Variables: Vars };

const DEVICE_AUTH_BASE = '/auth/device';

export const app = new Hono<AppEnv>();

app.onError((err) => {
  if (err instanceof AuthConfigError) {
    return errorResponse('SERVICE_UNAVAILABLE', { detail: err.message });
  }
  // 想定外エラーはまとめて 500。詳細（例外・スタック）はログのみ。
  return errorResponse('INTERNAL_ERROR', { detail: err });
});

app.notFound(() => errorResponse('NOT_FOUND'));

// リクエストごとに DB 接続を作り、レスポンス返却をブロックせずに閉じる。
// postgres.js は最初のクエリまで接続しないので、DB を使わないルートでは何も起きない。
app.use('*', async (c, next) => {
  const sql = createDb(c.env);
  c.set('sql', sql);
  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(sql.end({ timeout: 5 }));
  }
  // API の応答は既定でキャッシュさせない（Cookie 認証の応答を共有キャッシュに載せない）。
  // 公開系統ページなど、ルート側で Cache-Control を付けたものはそのまま。
  if (c.req.path.startsWith('/api/') && !c.res.headers.has('cache-control')) {
    c.res.headers.set('cache-control', 'private, no-store');
  }
});

app.get('/api/health', () => json({ service: 'pollenia-worker', ok: true }));

app.get('/photos/:token', (c) => handleGetPhoto(c.env, c.req.param('token')));

app.get('/public/plants/:id', (c) =>
  handlePublicPlant(c.var.sql, createPhotoSigner(c.env), c.req.param('id')),
);

app.all('/api/billing/webhook', (c) => {
  if (c.req.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED');
  return handleStripeWebhook(c.req.raw, c.env, c.var.sql);
});

// ログイン系とセッション必須の API だけが workers-auth を組み立てる（シークレット未設定でも
// 公開ページ・写真・Webhook は動く）。
const withAuth = createMiddleware<AppEnv>(async (c, next) => {
  c.set('authCtx', buildAuth(c.env, c.var.sql, c.req.url));
  await next();
});

app.use(`${DEVICE_AUTH_BASE}/*`, withAuth);
app.all(`${DEVICE_AUTH_BASE}/*`, (c) =>
  new Hono().route(DEVICE_AUTH_BASE, c.var.authCtx.device.routes()).fetch(c.req.raw, c.env),
);

app.use('/api/*', withAuth);
app.use('/api/*', (c, next) => c.var.authCtx.auth.middleware()(c, next));

app.all('/api/profiles', (c) => {
  if (c.req.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED');
  return handleCreateProfile(c.req.raw, c.var.sql, getUser(c).id);
});

app.all('/api/*', async (c) => {
  const sql = c.var.sql;
  const auth = await authenticateUser(sql, getUser(c).id);
  if (!auth.ok) return auth.response;
  return route(c.req.raw, c.env, sql, c.req.path, auth.value, createPhotoSigner(c.env));
});

export default app;

// /api/* のうち、セッション + profiles 行を要求するルート（ハンドラ実体は routes/）。
async function route(
  req: Request,
  env: Env,
  sql: Sql,
  pathname: string,
  user: AuthedUser,
  signPhotos: PhotoSigner,
): Promise<Response> {
  if (pathname === '/api/me') {
    if (req.method !== 'GET') return errorResponse('METHOD_NOT_ALLOWED');
    return handleGetMe(sql, user);
  }

  if (pathname === '/api/plants') {
    if (req.method === 'GET') return handleListPlants(req, sql, user);
    if (req.method === 'POST') return handleCreatePlant(req, sql, user);
    return errorResponse('METHOD_NOT_ALLOWED');
  }

  const plantLineage = pathname.match(/^\/api\/plants\/([^/]+)\/lineage$/);
  if (plantLineage) {
    if (req.method !== 'GET') return errorResponse('METHOD_NOT_ALLOWED');
    return handleGetLineage(req, sql, signPhotos, user, decodeURIComponent(plantLineage[1]));
  }

  const plantPhotos = pathname.match(/^\/api\/plants\/([^/]+)\/photos$/);
  if (plantPhotos) {
    if (req.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED');
    return handleCreatePhoto(req, sql, user, decodeURIComponent(plantPhotos[1]));
  }

  const plantById = pathname.match(/^\/api\/plants\/([^/]+)$/);
  if (plantById) {
    const id = decodeURIComponent(plantById[1]);
    if (req.method === 'GET') return handleGetPlant(sql, signPhotos, user, id);
    if (req.method === 'PATCH') return handleUpdatePlant(req, sql, user, id);
    if (req.method === 'DELETE') return handleDeletePlant(sql, user, id);
    return errorResponse('METHOD_NOT_ALLOWED');
  }

  const photoById = pathname.match(/^\/api\/photos\/([^/]+)$/);
  if (photoById) {
    if (req.method !== 'PUT') return errorResponse('METHOD_NOT_ALLOWED');
    return handleUploadPhoto(req, env, sql, user, decodeURIComponent(photoById[1]));
  }

  if (pathname === '/api/crossings') {
    if (req.method === 'GET') return handleListCrossings(req, sql, user);
    if (req.method === 'POST') return handleCreateCrossing(req, sql, user);
    return errorResponse('METHOD_NOT_ALLOWED');
  }

  const crossingHarvests = pathname.match(/^\/api\/crossings\/([^/]+)\/harvests$/);
  if (crossingHarvests) {
    if (req.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED');
    return handleCreateHarvest(req, sql, user, decodeURIComponent(crossingHarvests[1]));
  }

  const crossingById = pathname.match(/^\/api\/crossings\/([^/]+)$/);
  if (crossingById) {
    const id = decodeURIComponent(crossingById[1]);
    if (req.method === 'PATCH') return handleUpdateCrossing(req, sql, user, id);
    if (req.method === 'DELETE') return handleDeleteCrossing(sql, user, id);
    return errorResponse('METHOD_NOT_ALLOWED');
  }

  const harvestSowings = pathname.match(/^\/api\/harvests\/([^/]+)\/sowings$/);
  if (harvestSowings) {
    if (req.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED');
    return handleCreateSowing(req, sql, user, decodeURIComponent(harvestSowings[1]));
  }

  const sowingById = pathname.match(/^\/api\/sowings\/([^/]+)$/);
  if (sowingById) {
    if (req.method !== 'PATCH') return errorResponse('METHOD_NOT_ALLOWED');
    return handleUpdateSowing(req, sql, user, decodeURIComponent(sowingById[1]));
  }

  // --- Phase 3: AI -----------------------------------------------------------

  if (pathname === '/api/ai/consult') {
    if (req.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED');
    return handleAiConsult(req, env, sql, user);
  }

  if (pathname === '/api/ai/listing') {
    if (req.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED');
    return handleAiListing(req, env, sql, user);
  }

  // --- Phase 4: 課金（Checkout 作成。Webhook は認証前に処理済み） ------------

  if (pathname === '/api/billing/checkout') {
    if (req.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED');
    return handleCreateCheckout(req, env, sql, user);
  }

  if (pathname === '/api/billing/portal') {
    if (req.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED');
    return handleCreatePortal(req, env, sql, user);
  }

  // --- Phase 2: コミュニティ ------------------------------------------------

  if (pathname === '/api/feed') {
    if (req.method !== 'GET') return errorResponse('METHOD_NOT_ALLOWED');
    return handleFeed(req, sql, user);
  }

  if (pathname === '/api/posts') {
    if (req.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED');
    return handleCreatePost(req, sql, user);
  }

  const postLikes = pathname.match(/^\/api\/posts\/([^/]+)\/likes$/);
  if (postLikes) {
    const id = decodeURIComponent(postLikes[1]);
    if (req.method === 'POST') return handleCreateLike(sql, user, id);
    if (req.method === 'DELETE') return handleDeleteLike(sql, user, id);
    return errorResponse('METHOD_NOT_ALLOWED');
  }

  const postComments = pathname.match(/^\/api\/posts\/([^/]+)\/comments$/);
  if (postComments) {
    const id = decodeURIComponent(postComments[1]);
    if (req.method === 'GET') return handleListComments(req, sql, user, id);
    if (req.method === 'POST') return handleCreateComment(req, sql, user, id);
    return errorResponse('METHOD_NOT_ALLOWED');
  }

  const postById = pathname.match(/^\/api\/posts\/([^/]+)$/);
  if (postById) {
    if (req.method !== 'GET') return errorResponse('METHOD_NOT_ALLOWED');
    return handleGetPost(sql, user, decodeURIComponent(postById[1]));
  }

  if (pathname === '/api/follows') {
    if (req.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED');
    return handleCreateFollow(req, sql, user);
  }

  const followByFollowee = pathname.match(/^\/api\/follows\/([^/]+)$/);
  if (followByFollowee) {
    if (req.method !== 'DELETE') return errorResponse('METHOD_NOT_ALLOWED');
    return handleDeleteFollow(sql, user, decodeURIComponent(followByFollowee[1]));
  }

  const userPosts = pathname.match(/^\/api\/users\/([^/]+)\/posts$/);
  if (userPosts) {
    if (req.method !== 'GET') return errorResponse('METHOD_NOT_ALLOWED');
    return handleListUserPosts(req, sql, user, decodeURIComponent(userPosts[1]));
  }

  const userFollowers = pathname.match(/^\/api\/users\/([^/]+)\/followers$/);
  if (userFollowers) {
    if (req.method !== 'GET') return errorResponse('METHOD_NOT_ALLOWED');
    return handleListFollowers(req, sql, decodeURIComponent(userFollowers[1]));
  }

  const userFollowing = pathname.match(/^\/api\/users\/([^/]+)\/following$/);
  if (userFollowing) {
    if (req.method !== 'GET') return errorResponse('METHOD_NOT_ALLOWED');
    return handleListFollowing(req, sql, decodeURIComponent(userFollowing[1]));
  }

  const userById = pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userById) {
    if (req.method !== 'GET') return errorResponse('METHOD_NOT_ALLOWED');
    return handleGetUserProfile(sql, user, decodeURIComponent(userById[1]));
  }

  return errorResponse('NOT_FOUND');
}
