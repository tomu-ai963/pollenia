import type { Env } from './env';
import { json, preflight } from './lib/http';
import { errorResponse } from './lib/error-response';
import { createDb, type Sql } from './lib/db';
import { createSupabase } from './lib/supabase';
import { authenticateUser } from './lib/auth';
import { handleCreateProfile, handleGetMe } from './routes/profiles';
import {
  handleCreatePhoto,
  handleCreatePlant,
  handleDeletePlant,
  handleGetPlant,
  handleListPlants,
  handleUpdatePlant,
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
  handleCreatePost,
  handleDeleteLike,
  handleFeed,
  handleGetPost,
  handleListComments,
  handleListUserPosts,
} from './routes/posts';
import {
  handleCreateFollow,
  handleDeleteFollow,
  handleGetUserProfile,
  handleListFollowers,
  handleListFollowing,
} from './routes/follows';
import { handleAiConsult, handleAiListing } from './routes/ai';

// ルーティングのみ（ハンドラ実体は routes/）。Phase 1 のエンドポイント:
//   認証不要
//     - GET  /                          … ヘルスチェック
//     - GET  /public/plants/:id        … 公開系統ページ（p_viewer=null で RPC）
//   JWT のみ（profiles 行を要求しない）
//     - POST /api/profiles             … Pollenia への初回登録
//   JWT + profiles 行（README「掟」5: 有効な JWT ≠ Pollenia ユーザー）
//     - GET  /api/me
//     - GET/POST /api/plants、GET/PATCH/DELETE /api/plants/:id
//     - POST /api/plants/:id/photos    … Storage 署名アップロードURL発行
//     - GET/POST /api/crossings、PATCH/DELETE /api/crossings/:id、POST /api/crossings/:id/harvests
//     - POST /api/harvests/:id/sowings、PATCH /api/sowings/:id
//     - GET  /api/plants/:id/lineage?direction=up|down&depth=N
// Phase 2（コミュニティ。すべて JWT + profiles 行）:
//     - POST /api/posts、GET /api/posts/:id、GET /api/feed
//     - POST/DELETE /api/posts/:id/likes、GET/POST /api/posts/:id/comments
//     - POST /api/follows、DELETE /api/follows/:followee_id
//     - GET  /api/users/:id、/api/users/:id/posts、/followers、/following
// Phase 3（AI。すべて JWT + profiles 行）:
//     - POST /api/ai/consult            … 育種相談（自分の記録のみを RAG 参照）
//     - POST /api/ai/listing            … 出品文自動生成（自分の個体のみ）
// スコープ外: 課金（Stripe）。
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (req.method === 'OPTIONS') return preflight();
    if (req.method === 'GET' && pathname === '/') {
      return json({ service: 'pollenia-worker', ok: true });
    }

    const sql = createDb(env);
    try {
      return await route(req, env, sql, pathname);
    } catch (e) {
      // 想定外エラーはまとめて 500。詳細（例外・スタック）はログのみ。
      return errorResponse('INTERNAL_ERROR', { detail: e });
    } finally {
      // レスポンス返却をブロックせずに接続を閉じる
      ctx.waitUntil(sql.end({ timeout: 5 }));
    }
  },
};

async function route(req: Request, env: Env, sql: Sql, pathname: string): Promise<Response> {
  const supabase = createSupabase(env);

  // --- 認証不要: 公開系統ページ -------------------------------------------
  const publicPlant = pathname.match(/^\/public\/plants\/([^/]+)$/);
  if (publicPlant) {
    if (req.method !== 'GET') return errorResponse('METHOD_NOT_ALLOWED');
    return handlePublicPlant(sql, supabase, decodeURIComponent(publicPlant[1]));
  }

  if (!pathname.startsWith('/api/')) return errorResponse('NOT_FOUND');

  // --- JWT のみ: 初回登録 --------------------------------------------------
  if (pathname === '/api/profiles') {
    if (req.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED');
    return handleCreateProfile(req, supabase, sql);
  }

  // --- ここから先はすべて JWT + profiles 行を要求 --------------------------
  const auth = await authenticateUser(req, supabase, sql);
  if (!auth.ok) return auth.response;
  const user = auth.value;

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
    return handleGetLineage(req, sql, supabase, user, decodeURIComponent(plantLineage[1]));
  }

  const plantPhotos = pathname.match(/^\/api\/plants\/([^/]+)\/photos$/);
  if (plantPhotos) {
    if (req.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED');
    return handleCreatePhoto(req, sql, supabase, user, decodeURIComponent(plantPhotos[1]));
  }

  const plantById = pathname.match(/^\/api\/plants\/([^/]+)$/);
  if (plantById) {
    const id = decodeURIComponent(plantById[1]);
    if (req.method === 'GET') return handleGetPlant(sql, supabase, user, id);
    if (req.method === 'PATCH') return handleUpdatePlant(req, sql, user, id);
    if (req.method === 'DELETE') return handleDeletePlant(sql, user, id);
    return errorResponse('METHOD_NOT_ALLOWED');
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
