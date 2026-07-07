import type { SupabaseClient } from '@supabase/supabase-js';
import type { Sql } from '../lib/db';
import { json } from '../lib/http';
import { errorResponse } from '../lib/error-response';
import { canView, type Visibility } from '../lib/visibility';
import { isUuid } from '../lib/validate';
import { PUBLIC_CACHE_SECONDS, PUBLIC_LINEAGE_DEPTH } from '../constants';
import { buildLineage } from '../services/lineage';
import { listPhotosWithUrls } from './plants';

// GET /public/plants/:id — 認証不要の公開系統ページ（シェアURL）。
// - 入口の個体自体が visibility=public であることを Worker で確認してから RPC を呼ぶ
//   （非公開個体の共有 URL を弾く — api.md）。
// - RPC は p_viewer = null（匿名）で呼ぶ。public のノードだけが返る（README「掟」7）。
// - depth は固定（PUBLIC_LINEAGE_DEPTH）。クライアント指定は受けない。
// - Cache-Control は短め（visibility を private に戻した際の伝播遅延の許容値）。
export async function handlePublicPlant(
  sql: Sql,
  supabase: SupabaseClient,
  plantId: string,
): Promise<Response> {
  if (!isUuid(plantId)) return errorResponse('NOT_FOUND');

  const rows = await sql`
    select p.id, p.user_id, p.name, p.species, p.visibility, p.created_at,
           pr.display_name as owner_name
    from pollenia.plants p
    join pollenia.profiles pr on pr.id = p.user_id
    where p.id = ${plantId}::uuid and p.deleted_at is null
  `;
  if (rows.length === 0) return errorResponse('NOT_FOUND');
  const plant = rows[0];

  // 匿名 viewer（null）で判定 = visibility=public のみ通る。共通モジュール経由で統一。
  if (!canView(null, { ownerId: plant.user_id, visibility: plant.visibility as Visibility })) {
    return errorResponse('NOT_FOUND');
  }

  const [photos, ancestors, descendants] = await Promise.all([
    listPhotosWithUrls(sql, supabase, plantId),
    buildLineage(sql, supabase, 'up', plantId, null, PUBLIC_LINEAGE_DEPTH),
    buildLineage(sql, supabase, 'down', plantId, null, PUBLIC_LINEAGE_DEPTH),
  ]);

  return json(
    {
      plant: {
        id: plant.id,
        name: plant.name,
        species: plant.species,
        owner_name: plant.owner_name,
        created_at: plant.created_at,
      },
      photos,
      ancestors,
      descendants,
    },
    200,
    { 'cache-control': `public, max-age=${PUBLIC_CACHE_SECONDS}` },
  );
}
