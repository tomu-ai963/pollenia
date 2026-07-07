import type { SupabaseClient } from '@supabase/supabase-js';
import type { Sql } from '../lib/db';
import { json } from '../lib/http';
import { errorResponse } from '../lib/error-response';
import type { AuthedUser } from '../lib/auth';
import { canViewWithDb, type Visibility } from '../lib/visibility';
import { clampIntParam, isUuid } from '../lib/validate';
import { LINEAGE_DEPTH_DEFAULT, LINEAGE_DEPTH_MAX } from '../constants';
import { buildLineage, type LineageDirection } from '../services/lineage';

// GET /api/plants/:id/lineage?direction=up|down&depth=N — 認証必須の系統樹。
// p_viewer には**検証済み JWT の uid**を渡す（api.md「系統樹エンドポイント」）。
// depth はクライアント指定を素通りさせず [1, LINEAGE_DEPTH_MAX] にクランプする。
// エントリ個体自体が viewer から不可視なら 404（存在を秘匿）。
export async function handleGetLineage(
  req: Request,
  sql: Sql,
  supabase: SupabaseClient,
  user: AuthedUser,
  plantId: string,
): Promise<Response> {
  if (!isUuid(plantId)) return errorResponse('NOT_FOUND');

  const url = new URL(req.url);
  const dirParam = url.searchParams.get('direction') ?? 'up';
  if (dirParam !== 'up' && dirParam !== 'down') {
    return errorResponse('VALIDATION_ERROR', { publicMessage: 'direction は up | down。' });
  }
  const direction: LineageDirection = dirParam;
  const depth = clampIntParam(
    url.searchParams.get('depth'),
    1,
    LINEAGE_DEPTH_MAX,
    LINEAGE_DEPTH_DEFAULT,
  );

  const rows = await sql`
    select id, user_id, name, species, visibility
    from pollenia.plants
    where id = ${plantId}::uuid and deleted_at is null
  `;
  if (rows.length === 0) return errorResponse('NOT_FOUND');
  const plant = rows[0];

  // エントリ個体の可視性（get_descendants は基点自体を検査しないため Worker 側で必ず行う）
  const visible =
    plant.user_id === user.uid ||
    (await canViewWithDb(sql, user.uid, {
      ownerId: plant.user_id,
      visibility: plant.visibility as Visibility,
    }));
  if (!visible) return errorResponse('NOT_FOUND');

  const { edges, nodes } = await buildLineage(sql, supabase, direction, plantId, user.uid, depth);

  return json({
    plant: { id: plant.id, name: plant.name, species: plant.species },
    direction,
    depth,
    edges,
    nodes,
  });
}
