import type { Sql } from '../lib/db';
import type { PhotoSigner } from '../lib/photos';
import { json } from '../lib/http';
import { errorResponse } from '../lib/error-response';
import { canView, type Visibility } from '../lib/visibility';
import { clampIntParam, isUuid } from '../lib/validate';
import {
  GALLERY_MAX_OFFSET,
  GALLERY_PAGE_SIZE,
  PUBLIC_CACHE_SECONDS,
  PUBLIC_LINEAGE_DEPTH,
} from '../constants';
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
  signPhotos: PhotoSigner,
  plantId: string,
): Promise<Response> {
  if (!isUuid(plantId)) return errorResponse('NOT_FOUND');

  const rows = await sql`
    select p.id, p.user_id, p.name, p.species, p.visibility, p.traits, p.created_at,
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
    listPhotosWithUrls(sql, signPhotos, plantId),
    buildLineage(sql, signPhotos, 'up', plantId, null, PUBLIC_LINEAGE_DEPTH),
    buildLineage(sql, signPhotos, 'down', plantId, null, PUBLIC_LINEAGE_DEPTH),
  ]);

  return json(
    {
      plant: {
        id: plant.id,
        name: plant.name,
        species: plant.species,
        traits: plant.traits,
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

// GET /public/gallery?offset=N — 認証不要の公開ギャラリー（0005_gallery.sql）。
// - 載るのは visibility = public かつ in_gallery（本人が選んだもの）かつ未削除で、写真が 1 枚以上ある個体だけ。
//   SQL で絞ったうえで、匿名 viewer（null）の canView をもう一度通す（可視性判定の入口を lib/visibility.ts に揃える）
// - 返すのは公開系統ページと同じ範囲（名前・属種・持ち主の表示名）と、最新の写真 1 枚の署名 URL だけ。
//   notes・traits・user_id・origin_sowing_id は返さない（実生かどうかの真偽だけ）
// - 1 ページ GALLERY_PAGE_SIZE 件、offset は GALLERY_MAX_OFFSET まで（深いページングで DB を回させない）
export async function handlePublicGallery(
  req: Request,
  sql: Sql,
  signPhotos: PhotoSigner,
): Promise<Response> {
  const url = new URL(req.url);
  const offset = clampIntParam(url.searchParams.get('offset'), 0, GALLERY_MAX_OFFSET, 0);

  const rows = await sql`
    select p.id, p.user_id, p.name, p.species, p.visibility,
           (p.origin_sowing_id is not null) as is_seedling,
           pr.display_name as owner_name,
           ph.storage_path, ph.created_at as photo_at
    from pollenia.plants p
    join pollenia.profiles pr on pr.id = p.user_id
    join lateral (
      select storage_path, created_at from pollenia.plant_photos
      where plant_id = p.id and uploaded_at is not null
      order by created_at desc
      limit 1
    ) ph on true
    where p.visibility = 'public' and p.in_gallery and p.deleted_at is null
    order by ph.created_at desc, p.id
    limit ${GALLERY_PAGE_SIZE + 1} offset ${offset}
  `;
  const hasMore = rows.length > GALLERY_PAGE_SIZE;
  const visible = rows
    .slice(0, GALLERY_PAGE_SIZE)
    .filter((r) => canView(null, { ownerId: r.user_id, visibility: r.visibility as Visibility }));

  const urlByPath = visible.length ? await signPhotos(visible.map((r) => r.storage_path as string)) : new Map();
  const items = visible.map((r) => ({
    id: r.id,
    name: r.name,
    species: r.species,
    is_seedling: r.is_seedling,
    owner_name: r.owner_name,
    photo_url: urlByPath.get(r.storage_path as string) ?? null,
  }));

  return json(
    { items, next_offset: hasMore && offset + GALLERY_PAGE_SIZE <= GALLERY_MAX_OFFSET ? offset + GALLERY_PAGE_SIZE : null },
    200,
    { 'cache-control': `public, max-age=${PUBLIC_CACHE_SECONDS}` },
  );
}
