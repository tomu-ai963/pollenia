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
  handleListCrossings,
  handleUpdateSowing,
} from './routes/records';
import { handleGetLineage } from './routes/lineage';
import { handlePublicPlant } from './routes/public';

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
//     - GET/POST /api/crossings、POST /api/crossings/:id/harvests
//     - POST /api/harvests/:id/sowings、PATCH /api/sowings/:id
//     - GET  /api/plants/:id/lineage?direction=up|down&depth=N
// スコープ外（Phase 2/3）: posts / follows / likes / comments / AI / 課金。
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

  return errorResponse('NOT_FOUND');
}
