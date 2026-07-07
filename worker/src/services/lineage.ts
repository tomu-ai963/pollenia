import type { SupabaseClient } from '@supabase/supabase-js';
import { uuidArrayLiteral, type Sql } from '../lib/db';
import { PHOTO_BUCKET, PHOTO_SIGNED_URL_SECONDS } from '../constants';

// 系統樹の取得と組み立て。
// 可視性フィルタは RPC（pollenia.get_ancestors / get_descendants）側で完結しており、
// 非可視の親は seed_parent_id / pollen_parent_id が NULL でマスクされ、
// has_hidden_parent フラグだけが立って返る。
//
// 重要（README「掟」7）: Worker が名前・写真を join してよいのは
// **RPC が返した可視 plant_id だけ**。クライアント由来の ID や、系統に含まれる
// 生の ID 全件を無条件に plants / plant_photos へ join すると非公開個体が漏れる。

export type LineageDirection = 'up' | 'down';

export interface LineageEdge {
  plant_id: string;
  crossing_id: string;
  seed_parent_id: string | null;
  pollen_parent_id: string | null;
  depth: number;
  has_hidden_parent: boolean;
}

export interface LineageNode {
  id: string;
  name: string;
  species: string | null;
  deleted: boolean;
  photo_url: string | null;
}

// RPC 呼び出し。p_viewer は必ず呼び出し元エンドポイントの規約に従うこと:
//   /api/plants/:id/lineage → 検証済み JWT の uid / /public/plants/:id → null（匿名）
export async function fetchLineageEdges(
  sql: Sql,
  direction: LineageDirection,
  plantId: string,
  viewerId: string | null,
  maxDepth: number,
): Promise<LineageEdge[]> {
  const rows =
    direction === 'up'
      ? await sql`
          select plant_id, crossing_id, seed_parent_id, pollen_parent_id, depth, has_hidden_parent
          from pollenia.get_ancestors(${plantId}::uuid, ${viewerId}::uuid, ${maxDepth}::int)
        `
      : await sql`
          select plant_id, crossing_id, seed_parent_id, pollen_parent_id, depth, has_hidden_parent
          from pollenia.get_descendants(${plantId}::uuid, ${viewerId}::uuid, ${maxDepth}::int)
        `;
  return rows as unknown as LineageEdge[];
}

// RPC の返却行から「可視な plant_id」を集める純粋関数。
// - plant_id 列は RPC が可視性を通したノードのみ
// - seed/pollen_parent_id は非可視なら NULL 化済み → 非 NULL のものだけ拾う
// - エントリ個体（呼び出し側で可視性確認済み）も含める
export function collectVisiblePlantIds(entryId: string, edges: LineageEdge[]): string[] {
  const ids = new Set<string>([entryId]);
  for (const e of edges) {
    ids.add(e.plant_id);
    if (e.seed_parent_id) ids.add(e.seed_parent_id);
    if (e.pollen_parent_id) ids.add(e.pollen_parent_id);
  }
  return [...ids];
}

// 可視 plant_id に限って名前・種・代表写真（最新1枚）を引き、ノード表を作る。
// soft delete 済みの個体も系統の整合のため含める（deleted フラグで区別）。
export async function buildLineageNodes(
  sql: Sql,
  supabase: SupabaseClient,
  visibleIds: string[],
): Promise<Record<string, LineageNode>> {
  if (visibleIds.length === 0) return {};

  const plants = await sql`
    select id, name, species, deleted_at
    from pollenia.plants
    where id = any(${uuidArrayLiteral(visibleIds)}::uuid[])
  `;
  const photos = await sql`
    select distinct on (plant_id) plant_id, storage_path
    from pollenia.plant_photos
    where plant_id = any(${uuidArrayLiteral(visibleIds)}::uuid[])
    order by plant_id, created_at desc
  `;

  const urlByPath = new Map<string, string>();
  if (photos.length > 0) {
    const { data: signed } = await supabase.storage
      .from(PHOTO_BUCKET)
      .createSignedUrls(photos.map((p) => p.storage_path), PHOTO_SIGNED_URL_SECONDS);
    for (const s of signed ?? []) {
      if (s.signedUrl) urlByPath.set(s.path ?? '', s.signedUrl);
    }
  }
  const pathByPlant = new Map(photos.map((p) => [p.plant_id, p.storage_path]));

  const nodes: Record<string, LineageNode> = {};
  for (const p of plants) {
    const path = pathByPlant.get(p.id);
    nodes[p.id] = {
      id: p.id,
      name: p.name,
      species: p.species,
      deleted: p.deleted_at !== null,
      photo_url: path ? urlByPath.get(path) ?? null : null,
    };
  }
  return nodes;
}

// エッジ + ノード表を一括で組み立てる（lineage / public 共用）。
export async function buildLineage(
  sql: Sql,
  supabase: SupabaseClient,
  direction: LineageDirection,
  entryId: string,
  viewerId: string | null,
  maxDepth: number,
): Promise<{ edges: LineageEdge[]; nodes: Record<string, LineageNode> }> {
  const edges = await fetchLineageEdges(sql, direction, entryId, viewerId, maxDepth);
  const nodes = await buildLineageNodes(sql, supabase, collectVisiblePlantIds(entryId, edges));
  return { edges, nodes };
}
