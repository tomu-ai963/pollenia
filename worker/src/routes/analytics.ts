import { uuidArrayLiteral, type Sql } from '../lib/db';
import { json } from '../lib/http';
import type { AuthedUser } from '../lib/auth';
import { requireActiveSubscription } from '../lib/stripe';
import {
  groupByCrossing,
  groupByParent,
  summarizeSowings,
  type SowingWithParents,
} from '../lib/germination';
import { ANALYTICS_MAX_SOWINGS } from '../constants';
import { summarizeOffspring } from '../lib/segregation';
import { traitEntries } from '../../../frontend/src/trait-spec.js';

// 発芽率の集計 API。交配・採種・播種は所有者のみのデータ（datamodel.md）なので、
// すべてのクエリを検証済み uid で絞る（他人の記録は集計にも名前にも出ない）。
//
// - GET /api/analytics/germination          … 交配ごと + 全体（無料）
// - GET /api/analytics/germination/parents  … 親個体ごとの比較（有料。未加入は 402）
// - GET /api/analytics/segregation          … 交配ごとの形質の分離（有料。未加入は 402）

// 自分の播種を、交配の両親 ID と一緒に引く（新しい播種から ANALYTICS_MAX_SOWINGS 件まで）。
// 発芽までの日数は SQL の date 同士の差（整数の日数）で出す。
async function loadSowings(sql: Sql, uid: string): Promise<SowingWithParents[]> {
  const rows = await sql`
    select c.id as crossing_id, c.seed_parent_id, c.pollen_parent_id,
           s.sowing_count, s.germination_count,
           (s.first_germination_date - s.sowing_date) as days_to_germination
    from pollenia.sowings s
    join pollenia.seed_harvests h on h.id = s.seed_harvest_id and h.user_id = ${uid}::uuid
    join pollenia.crossings c on c.id = h.crossing_id and c.user_id = ${uid}::uuid
    where s.user_id = ${uid}::uuid
      -- 播種数も発芽数も無い播種（CSV 取り込みで系統をつなぐために作ったもの）は集計に入れない
      and (s.sowing_count is not null or s.germination_count is not null)
    order by s.created_at desc
    limit ${ANALYTICS_MAX_SOWINGS}
  `;
  return rows as unknown as SowingWithParents[];
}

async function loadPlantNames(sql: Sql, uid: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await sql`
    select id, name from pollenia.plants
    where id = any(${uuidArrayLiteral(ids)}::uuid[]) and user_id = ${uid}::uuid
  `;
  return new Map(rows.map((r) => [r.id as string, r.name as string]));
}

// GET /api/analytics/germination — 交配ごとの発芽率と全体の合計（無料）。
export async function handleGerminationByCrossing(sql: Sql, user: AuthedUser): Promise<Response> {
  const rows = await loadSowings(sql, user.uid);
  const byCrossing = groupByCrossing(rows);
  const crossingIds = [...byCrossing.keys()];

  // cross_date は ::text で YYYY-MM-DD のまま返す（postgres.js は date を Date＝日時にしてしまう）
  const crossings = crossingIds.length
    ? await sql`
        select id, cross_date::text as cross_date from pollenia.crossings
        where id = any(${uuidArrayLiteral(crossingIds)}::uuid[]) and user_id = ${user.uid}::uuid
      `
    : [];
  const crossDate = new Map(crossings.map((c) => [c.id as string, c.cross_date ?? null]));

  const parentIds = [
    ...new Set(rows.flatMap((r) => [r.seed_parent_id, r.pollen_parent_id]).filter((x): x is string => !!x)),
  ];
  const names = await loadPlantNames(sql, user.uid, parentIds);

  const items = crossingIds.map((id) => {
    const list = byCrossing.get(id)!;
    const first = list[0];
    return {
      crossing_id: id,
      cross_date: crossDate.get(id) ?? null,
      seed_parent_id: first.seed_parent_id,
      seed_parent_name: names.get(first.seed_parent_id) ?? null,
      pollen_parent_id: first.pollen_parent_id,
      pollen_parent_name: first.pollen_parent_id ? (names.get(first.pollen_parent_id) ?? null) : null,
      ...summarizeSowings(list),
    };
  });

  return json({ overall: summarizeSowings(rows), crossings: items });
}

// GET /api/analytics/germination/parents — 親個体ごとの比較（有料）。
export async function handleGerminationByParent(sql: Sql, user: AuthedUser): Promise<Response> {
  // 有料ゲート: 未加入（free/canceled）は 402。集計の前に判定する。
  const sub = await requireActiveSubscription(sql, user.uid);
  if (!sub.ok) return sub.response;

  const rows = await loadSowings(sql, user.uid);
  const parents = groupByParent(rows);
  const names = await loadPlantNames(
    sql,
    user.uid,
    parents.map((p) => p.plant_id),
  );
  return json({
    parents: parents.map((p) => ({ ...p, name: names.get(p.plant_id) ?? null })),
  });
}

// GET /api/analytics/segregation — 交配ごとの形質の分離（有料）。
// 子 = 自分の未削除の個体のうち、その交配の播種から生まれたもの（plants.origin_sowing_id）。
// 子が 1 本以上いる交配だけを、新しい交配から返す。両親の特性も比べるために添える（自分の個体だけ）。
export async function handleSegregation(sql: Sql, user: AuthedUser): Promise<Response> {
  const sub = await requireActiveSubscription(sql, user.uid);
  if (!sub.ok) return sub.response;

  const uid = user.uid;
  const rows = await sql`
    select c.id as crossing_id, c.seed_parent_id, c.pollen_parent_id, c.cross_date::text as cross_date,
           c.created_at as crossing_created_at, p.traits
    from pollenia.plants p
    join pollenia.sowings s on s.id = p.origin_sowing_id and s.user_id = ${uid}::uuid
    join pollenia.seed_harvests h on h.id = s.seed_harvest_id and h.user_id = ${uid}::uuid
    join pollenia.crossings c on c.id = h.crossing_id and c.user_id = ${uid}::uuid
    where p.user_id = ${uid}::uuid and p.deleted_at is null
    order by c.created_at desc
    limit ${ANALYTICS_MAX_SOWINGS}
  `;

  const byCrossing = new Map<string, { row: (typeof rows)[number]; traits: unknown[] }>();
  for (const r of rows) {
    const e = byCrossing.get(r.crossing_id as string);
    if (e) e.traits.push(r.traits);
    else byCrossing.set(r.crossing_id as string, { row: r, traits: [r.traits] });
  }

  const parentIds = [
    ...new Set(rows.flatMap((r) => [r.seed_parent_id, r.pollen_parent_id]).filter((x): x is string => !!x)),
  ];
  const parents = parentIds.length
    ? await sql`
        select id, name, traits from pollenia.plants
        where id = any(${uuidArrayLiteral(parentIds)}::uuid[]) and user_id = ${uid}::uuid
      `
    : [];
  const parentById = new Map(parents.map((p) => [p.id as string, p]));
  const parentOf = (id: unknown) => {
    const p = id ? parentById.get(id as string) : undefined;
    return p ? { id: p.id, name: p.name, traits: traitEntries(p.traits) } : null;
  };

  return json({
    crossings: [...byCrossing.values()].map(({ row, traits }) => ({
      crossing_id: row.crossing_id,
      cross_date: row.cross_date,
      self: !!row.pollen_parent_id && row.pollen_parent_id === row.seed_parent_id,
      seed_parent: parentOf(row.seed_parent_id),
      pollen_parent: parentOf(row.pollen_parent_id),
      offspring: traits.length,
      traits: summarizeOffspring(traits),
    })),
  });
}
