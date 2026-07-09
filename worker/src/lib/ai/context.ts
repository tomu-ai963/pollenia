import { uuidArrayLiteral, type Sql } from '../db';
import { AI_CHUNK_NOTES_MAX, AI_SYNC_MAX_ROWS_PER_TABLE, BLOOM_SEASONS } from '../../constants';

// 育種相談AI / 出品文生成の参照データ（RAG チャンク）の組み立て。
//
// セキュリティ上の要点:
//   * すべてのクエリを user_id で絞る（他ユーザーの記録は一切含めない）。
//     親個体名の join も owner 条件付き（交配作成時に自分の個体に限定済みだが defense in depth）。
//   * 参照範囲は plants / crossings / seed_harvests / sowings のみ。
//     posts / comments は含めない（プロダクト方針。0005_ai.sql の CHECK とも一致）。
//   * テーブルごとに新しい順で AI_SYNC_MAX_ROWS_PER_TABLE 件まで（トークン量の上限）。
//   * notes は AI_CHUNK_NOTES_MAX 文字で切り詰める。notes はデータであって指示ではない
//     扱いをプロンプト側（lib/ai/anthropic.ts）で徹底する。

export type AiSourceType = 'plant' | 'crossing' | 'seed_harvest' | 'sowing';

export interface AiSource {
  source_type: AiSourceType;
  source_id: string;
  content: string;
}

export interface AiOverview {
  plants: number;
  crossings: number;
  seed_harvests: number;
  sowings: number;
}

// --- 純粋な整形関数（vitest 対象） ------------------------------------------

const BLOOM_SEASON_JP: Record<string, string> = {
  spring: '春',
  early_summer: '初夏',
  summer: '夏',
  autumn: '秋',
  winter: '冬',
};

// traits（構造化特性）を日本語ラベルの1行に整形。未知キーは無視（lib/traits.ts で
// 既知キーのみ保存される前提だが、過去データ・手動投入に対する防御）。
export function formatTraits(traits: unknown): string | null {
  if (!traits || typeof traits !== 'object' || Array.isArray(traits)) return null;
  const t = traits as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof t.bloom_season === 'string' && (BLOOM_SEASONS as readonly string[]).includes(t.bloom_season)) {
    parts.push(`開花期=${BLOOM_SEASON_JP[t.bloom_season] ?? t.bloom_season}`);
  }
  if (typeof t.fragrance_strength === 'number') parts.push(`香りの強さ=${t.fragrance_strength}/5`);
  if (typeof t.fragrance_type === 'string') parts.push(`香りの系統=${t.fragrance_type}`);
  if (typeof t.plant_height_cm === 'number') parts.push(`草丈=${t.plant_height_cm}cm`);
  if (typeof t.flower_size_cm === 'number') parts.push(`花のサイズ=${t.flower_size_cm}cm`);
  return parts.length ? parts.join(', ') : null;
}

// notes の切り詰め（プロンプトの暴発防止）。
export function truncateNotes(notes: unknown, max = AI_CHUNK_NOTES_MAX): string | null {
  if (typeof notes !== 'string') return null;
  const s = notes.trim();
  if (!s) return null;
  return s.length <= max ? s : `${s.slice(0, max)}…（以下省略）`;
}

// 「母木 × 花粉親」表記。花粉親 null は父不明（自然交雑含む）として明記する。
export function formatParents(seedParentName: unknown, pollenParentName: unknown): string {
  const seed = typeof seedParentName === 'string' && seedParentName ? seedParentName : '（不明）';
  const pollen =
    typeof pollenParentName === 'string' && pollenParentName ? pollenParentName : '（父不明）';
  return `${seed} × ${pollen}`;
}

interface PlantChunkInput {
  name: string;
  species: string | null;
  notes: string | null;
  traits: unknown;
  origin_sowing_id: string | null;
  seed_parent_name?: string | null;
  pollen_parent_name?: string | null;
  created_at?: unknown;
}

export function buildPlantChunk(p: PlantChunkInput): string {
  const parts = [`【個体】${p.name}`];
  if (p.species) parts.push(`属・種: ${p.species}`);
  parts.push(
    p.origin_sowing_id
      ? `由来: 自家実生（両親: ${formatParents(p.seed_parent_name, p.pollen_parent_name)}）`
      : '由来: 導入株（購入・譲渡など）',
  );
  const traits = formatTraits(p.traits);
  if (traits) parts.push(`特性: ${traits}`);
  const notes = truncateNotes(p.notes);
  if (notes) parts.push(`メモ: ${notes}`);
  return parts.join(' / ');
}

interface CrossingChunkInput {
  seed_parent_name: string | null;
  pollen_parent_name: string | null;
  cross_date: unknown;
  notes: string | null;
}

export function buildCrossingChunk(c: CrossingChunkInput): string {
  const parts = [`【交配】${formatParents(c.seed_parent_name, c.pollen_parent_name)}`];
  if (c.cross_date) parts.push(`交配日: ${c.cross_date}`);
  const notes = truncateNotes(c.notes);
  if (notes) parts.push(`メモ: ${notes}`);
  return parts.join(' / ');
}

interface HarvestChunkInput {
  seed_parent_name: string | null;
  pollen_parent_name: string | null;
  harvest_date: unknown;
  seed_count: number | null;
  notes: string | null;
}

export function buildHarvestChunk(h: HarvestChunkInput): string {
  const parts = [`【採種】交配 ${formatParents(h.seed_parent_name, h.pollen_parent_name)} から採種`];
  if (h.harvest_date) parts.push(`採種日: ${h.harvest_date}`);
  if (h.seed_count !== null && h.seed_count !== undefined) parts.push(`採種数: ${h.seed_count}粒`);
  const notes = truncateNotes(h.notes);
  if (notes) parts.push(`メモ: ${notes}`);
  return parts.join(' / ');
}

interface SowingChunkInput {
  seed_parent_name: string | null;
  pollen_parent_name: string | null;
  sowing_date: unknown;
  sowing_count: number | null;
  germination_count: number | null;
  first_germination_date: unknown;
  notes: string | null;
}

export function buildSowingChunk(s: SowingChunkInput): string {
  const parts = [`【播種】交配 ${formatParents(s.seed_parent_name, s.pollen_parent_name)} の種子を播種`];
  if (s.sowing_date) parts.push(`播種日: ${s.sowing_date}`);
  if (s.sowing_count !== null && s.sowing_count !== undefined) parts.push(`播種数: ${s.sowing_count}粒`);
  if (s.germination_count !== null && s.germination_count !== undefined) {
    parts.push(`発芽数: ${s.germination_count}`);
  }
  if (s.first_germination_date) parts.push(`初発芽日: ${s.first_germination_date}`);
  const notes = truncateNotes(s.notes);
  if (notes) parts.push(`メモ: ${notes}`);
  return parts.join(' / ');
}

// --- DB からの収集 -----------------------------------------------------------

// ユーザー自身の記録をチャンク化する。呼び出し元は必ず検証済み uid を渡すこと。
export async function collectUserSources(
  sql: Sql,
  uid: string,
): Promise<{ sources: AiSource[]; overview: AiOverview }> {
  const limit = AI_SYNC_MAX_ROWS_PER_TABLE;

  // 個体（+ 実生なら両親名。親個体は作成時に自分の個体へ限定済みだが owner 条件も付ける）
  const plants = await sql`
    select p.id, p.name, p.species, p.notes, p.traits, p.origin_sowing_id, p.created_at
    from pollenia.plants p
    where p.user_id = ${uid}::uuid and p.deleted_at is null
    order by p.created_at desc
    limit ${limit}
  `;

  const originIds = plants.filter((p) => p.origin_sowing_id).map((p) => p.id);
  const parentRows = originIds.length
    ? await sql`
        select pp.plant_id,
               sp.name as seed_parent_name,
               fp.name as pollen_parent_name
        from pollenia.plant_parents pp
        left join pollenia.plants sp on sp.id = pp.seed_parent_id and sp.user_id = ${uid}::uuid
        left join pollenia.plants fp on fp.id = pp.pollen_parent_id and fp.user_id = ${uid}::uuid
        where pp.plant_id = any(${uuidArrayLiteral(originIds)}::uuid[])
      `
    : [];
  const parentsByPlant = new Map(parentRows.map((r) => [r.plant_id, r]));

  // 交配（両親名付き）
  const crossings = await sql`
    select c.id, c.cross_date, c.notes,
           sp.name as seed_parent_name,
           fp.name as pollen_parent_name
    from pollenia.crossings c
    left join pollenia.plants sp on sp.id = c.seed_parent_id and sp.user_id = ${uid}::uuid
    left join pollenia.plants fp on fp.id = c.pollen_parent_id and fp.user_id = ${uid}::uuid
    where c.user_id = ${uid}::uuid
    order by c.created_at desc
    limit ${limit}
  `;

  // 採種（交配の両親名を添える）
  const harvests = await sql`
    select h.id, h.harvest_date, h.seed_count, h.notes,
           sp.name as seed_parent_name,
           fp.name as pollen_parent_name
    from pollenia.seed_harvests h
    join pollenia.crossings c on c.id = h.crossing_id and c.user_id = ${uid}::uuid
    left join pollenia.plants sp on sp.id = c.seed_parent_id and sp.user_id = ${uid}::uuid
    left join pollenia.plants fp on fp.id = c.pollen_parent_id and fp.user_id = ${uid}::uuid
    where h.user_id = ${uid}::uuid
    order by h.created_at desc
    limit ${limit}
  `;

  // 播種（同上）
  const sowings = await sql`
    select s.id, s.sowing_date, s.sowing_count, s.germination_count,
           s.first_germination_date, s.notes,
           sp.name as seed_parent_name,
           fp.name as pollen_parent_name
    from pollenia.sowings s
    join pollenia.seed_harvests h on h.id = s.seed_harvest_id and h.user_id = ${uid}::uuid
    join pollenia.crossings c on c.id = h.crossing_id and c.user_id = ${uid}::uuid
    left join pollenia.plants sp on sp.id = c.seed_parent_id and sp.user_id = ${uid}::uuid
    left join pollenia.plants fp on fp.id = c.pollen_parent_id and fp.user_id = ${uid}::uuid
    where s.user_id = ${uid}::uuid
    order by s.created_at desc
    limit ${limit}
  `;

  const sources: AiSource[] = [
    ...plants.map((p) => ({
      source_type: 'plant' as const,
      source_id: p.id as string,
      content: buildPlantChunk({
        name: p.name,
        species: p.species,
        notes: p.notes,
        traits: p.traits,
        origin_sowing_id: p.origin_sowing_id,
        seed_parent_name: parentsByPlant.get(p.id)?.seed_parent_name ?? null,
        pollen_parent_name: parentsByPlant.get(p.id)?.pollen_parent_name ?? null,
      }),
    })),
    ...crossings.map((c) => ({
      source_type: 'crossing' as const,
      source_id: c.id as string,
      content: buildCrossingChunk(c as never),
    })),
    ...harvests.map((h) => ({
      source_type: 'seed_harvest' as const,
      source_id: h.id as string,
      content: buildHarvestChunk(h as never),
    })),
    ...sowings.map((s) => ({
      source_type: 'sowing' as const,
      source_id: s.id as string,
      content: buildSowingChunk(s as never),
    })),
  ];

  return {
    sources,
    overview: {
      plants: plants.length,
      crossings: crossings.length,
      seed_harvests: harvests.length,
      sowings: sowings.length,
    },
  };
}

// 出品文生成の対象個体1件の「事実」テキスト。所有チェック済みの plant 行を渡すこと。
// RAG は使わず、対象個体そのもの + 系統情報だけを事実として渡す（不要な記録を混ぜない）。
export async function buildListingFacts(
  sql: Sql,
  uid: string,
  plant: {
    id: string;
    name: string;
    species: string | null;
    notes: string | null;
    traits: unknown;
    origin_sowing_id: string | null;
  },
): Promise<string> {
  let seedParentName: string | null = null;
  let pollenParentName: string | null = null;
  if (plant.origin_sowing_id) {
    const rows = await sql`
      select sp.name as seed_parent_name,
             fp.name as pollen_parent_name
      from pollenia.plant_parents pp
      left join pollenia.plants sp on sp.id = pp.seed_parent_id and sp.user_id = ${uid}::uuid
      left join pollenia.plants fp on fp.id = pp.pollen_parent_id and fp.user_id = ${uid}::uuid
      where pp.plant_id = ${plant.id}::uuid
    `;
    if (rows.length > 0) {
      seedParentName = rows[0].seed_parent_name;
      pollenParentName = rows[0].pollen_parent_name;
    }
  }

  return buildPlantChunk({
    name: plant.name,
    species: plant.species,
    notes: plant.notes,
    traits: plant.traits,
    origin_sowing_id: plant.origin_sowing_id,
    seed_parent_name: seedParentName,
    pollen_parent_name: pollenParentName,
  });
}
