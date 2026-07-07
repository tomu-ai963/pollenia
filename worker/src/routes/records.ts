import { uuidArrayLiteral, type Sql } from '../lib/db';
import { json } from '../lib/http';
import { errorResponse } from '../lib/error-response';
import type { AuthedUser } from '../lib/auth';
import { asDateStr, asNonNegInt, asText, clampIntParam, isUuid } from '../lib/validate';
import { LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, MAX_TEXT_LEN } from '../constants';

// 交配（crossings）・採種（seed_harvests）・播種（sowings）の記録 API。
// これらは visibility 列を持たない＝**所有者のみ**のデータ（datamodel.md）。
// すべてのクエリを user_id で絞り、他人の記録には 404 を返す（存在を秘匿）。

// GET /api/crossings — 自分の交配一覧。採種・播種をネストし、親個体名を添える。?limit&offset
export async function handleListCrossings(
  req: Request,
  sql: Sql,
  user: AuthedUser,
): Promise<Response> {
  const url = new URL(req.url);
  const limit = clampIntParam(url.searchParams.get('limit'), 1, LIST_LIMIT_MAX, LIST_LIMIT_DEFAULT);
  const offset = clampIntParam(url.searchParams.get('offset'), 0, 100_000, 0);

  const crossings = await sql`
    select id, seed_parent_id, pollen_parent_id, cross_date, notes, created_at, updated_at
    from pollenia.crossings
    where user_id = ${user.uid}::uuid
    order by created_at desc
    limit ${limit} offset ${offset}
  `;
  if (crossings.length === 0) return json({ crossings: [] });

  const crossingIds = crossings.map((c) => c.id);
  const harvests = await sql`
    select id, crossing_id, harvest_date, seed_count, notes, created_at, updated_at
    from pollenia.seed_harvests
    where crossing_id = any(${uuidArrayLiteral(crossingIds)}::uuid[]) and user_id = ${user.uid}::uuid
    order by created_at
  `;
  const harvestIds = harvests.map((h) => h.id);
  const sowings = harvestIds.length
    ? await sql`
        select id, seed_harvest_id, sowing_date, sowing_count, germination_count,
               first_germination_date, notes, created_at, updated_at
        from pollenia.sowings
        where seed_harvest_id = any(${uuidArrayLiteral(harvestIds)}::uuid[]) and user_id = ${user.uid}::uuid
        order by created_at
      `
    : [];

  // 親個体名。作成時に自分の個体に限定しているため所有チェック込みで引く。
  const parentIds = [
    ...new Set(
      crossings.flatMap((c) => [c.seed_parent_id, c.pollen_parent_id]).filter(Boolean),
    ),
  ];
  const parents = parentIds.length
    ? await sql`
        select id, name from pollenia.plants
        where id = any(${uuidArrayLiteral(parentIds)}::uuid[]) and user_id = ${user.uid}::uuid
      `
    : [];
  const nameById = new Map(parents.map((p) => [p.id, p.name]));

  const sowingsByHarvest = new Map<string, unknown[]>();
  for (const s of sowings) {
    const list = sowingsByHarvest.get(s.seed_harvest_id) ?? [];
    list.push(s);
    sowingsByHarvest.set(s.seed_harvest_id, list);
  }
  const harvestsByCrossing = new Map<string, unknown[]>();
  for (const h of harvests) {
    const list = harvestsByCrossing.get(h.crossing_id) ?? [];
    list.push({ ...h, sowings: sowingsByHarvest.get(h.id) ?? [] });
    harvestsByCrossing.set(h.crossing_id, list);
  }

  return json({
    crossings: crossings.map((c) => ({
      ...c,
      seed_parent_name: nameById.get(c.seed_parent_id) ?? null,
      pollen_parent_name: c.pollen_parent_id ? nameById.get(c.pollen_parent_id) ?? null : null,
      harvests: harvestsByCrossing.get(c.id) ?? [],
    })),
  });
}

// POST /api/crossings — 交配記録の作成。
// Request: { seed_parent_id(必須), pollen_parent_id?, cross_date?, notes? }
// 親個体は**自分の未削除個体**に限定する（他人の個体 ID を親として保存させない — 仮決め。
// 他ユーザーの公開個体を親にする「導入株の系統接続」は Phase 2 以降で検討）。
// 自家受粉（両親同一）・父不明（pollen_parent_id なし）は正当な記録として許容。
export async function handleCreateCrossing(
  req: Request,
  sql: Sql,
  user: AuthedUser,
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return errorResponse('VALIDATION_ERROR', { publicMessage: 'JSON ボディが必要です。' });

  if (!isUuid(body.seed_parent_id)) {
    return errorResponse('VALIDATION_ERROR', { publicMessage: 'seed_parent_id は必須です。' });
  }
  const seedParentId = body.seed_parent_id;
  let pollenParentId: string | null = null;
  if (body.pollen_parent_id !== undefined && body.pollen_parent_id !== null) {
    if (!isUuid(body.pollen_parent_id)) {
      return errorResponse('VALIDATION_ERROR', { publicMessage: 'pollen_parent_id が不正です。' });
    }
    pollenParentId = body.pollen_parent_id;
  }

  const dates = parseRecordFields(body, ['cross_date']);
  if (!dates.ok) return dates.response;
  const crossDate = dates.value.cross_date ?? null;
  const notes = dates.value.notes;

  const checkIds = pollenParentId ? [seedParentId, pollenParentId] : [seedParentId];
  const owned = await sql`
    select id from pollenia.plants
    where id = any(${uuidArrayLiteral(checkIds)}::uuid[]) and user_id = ${user.uid}::uuid and deleted_at is null
  `;
  const ownedIds = new Set(owned.map((r) => r.id));
  if (!ownedIds.has(seedParentId) || (pollenParentId && !ownedIds.has(pollenParentId))) {
    return errorResponse('VALIDATION_ERROR', {
      publicMessage: '親個体は自分の（削除されていない）個体である必要があります。',
    });
  }

  const rows = await sql`
    insert into pollenia.crossings (user_id, seed_parent_id, pollen_parent_id, cross_date, notes)
    values (${user.uid}::uuid, ${seedParentId}::uuid,
            ${pollenParentId}, ${crossDate}, ${notes})
    returning id, seed_parent_id, pollen_parent_id, cross_date, notes, created_at, updated_at
  `;
  return json({ crossing: rows[0] }, 201);
}

// POST /api/crossings/:id/harvests — 採種記録。crossing は自分のもの限定。
// Request: { harvest_date?, seed_count?, notes? }
export async function handleCreateHarvest(
  req: Request,
  sql: Sql,
  user: AuthedUser,
  crossingId: string,
): Promise<Response> {
  if (!isUuid(crossingId)) return errorResponse('NOT_FOUND');
  const own = await sql`
    select 1 from pollenia.crossings
    where id = ${crossingId}::uuid and user_id = ${user.uid}::uuid
  `;
  if (own.length === 0) return errorResponse('NOT_FOUND');

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return errorResponse('VALIDATION_ERROR', { publicMessage: 'JSON ボディが必要です。' });

  const parsed = parseRecordFields(body, ['harvest_date'], ['seed_count']);
  if (!parsed.ok) return parsed.response;

  const rows = await sql`
    insert into pollenia.seed_harvests (user_id, crossing_id, harvest_date, seed_count, notes)
    values (${user.uid}::uuid, ${crossingId}::uuid,
            ${parsed.value.harvest_date ?? null}, ${parsed.value.seed_count ?? null},
            ${parsed.value.notes})
    returning id, crossing_id, harvest_date, seed_count, notes, created_at, updated_at
  `;
  return json({ harvest: rows[0] }, 201);
}

// POST /api/harvests/:id/sowings — 播種記録。harvest は自分のもの限定。
// Request: { sowing_date?, sowing_count?, germination_count?, first_germination_date?, notes? }
export async function handleCreateSowing(
  req: Request,
  sql: Sql,
  user: AuthedUser,
  harvestId: string,
): Promise<Response> {
  if (!isUuid(harvestId)) return errorResponse('NOT_FOUND');
  const own = await sql`
    select 1 from pollenia.seed_harvests
    where id = ${harvestId}::uuid and user_id = ${user.uid}::uuid
  `;
  if (own.length === 0) return errorResponse('NOT_FOUND');

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return errorResponse('VALIDATION_ERROR', { publicMessage: 'JSON ボディが必要です。' });

  const parsed = parseRecordFields(
    body,
    ['sowing_date', 'first_germination_date'],
    ['sowing_count', 'germination_count'],
  );
  if (!parsed.ok) return parsed.response;
  const v = parsed.value;

  const rows = await sql`
    insert into pollenia.sowings
      (user_id, seed_harvest_id, sowing_date, sowing_count, germination_count,
       first_germination_date, notes)
    values (${user.uid}::uuid, ${harvestId}::uuid, ${v.sowing_date ?? null},
            ${v.sowing_count ?? null}, ${v.germination_count ?? null},
            ${v.first_germination_date ?? null}, ${v.notes})
    returning id, seed_harvest_id, sowing_date, sowing_count, germination_count,
              first_germination_date, notes, created_at, updated_at
  `;
  return json({ sowing: rows[0] }, 201);
}

// PATCH /api/sowings/:id — 発芽数・日付等の更新（発芽率グラフの元データ）。自分のもの限定。
export async function handleUpdateSowing(
  req: Request,
  sql: Sql,
  user: AuthedUser,
  sowingId: string,
): Promise<Response> {
  if (!isUuid(sowingId)) return errorResponse('NOT_FOUND');
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return errorResponse('VALIDATION_ERROR', { publicMessage: 'JSON ボディが必要です。' });

  const parsed = parseRecordFields(
    body,
    ['sowing_date', 'first_germination_date'],
    ['sowing_count', 'germination_count'],
  );
  if (!parsed.ok) return parsed.response;

  const patch: Record<string, unknown> = {};
  for (const key of [
    'sowing_date',
    'first_germination_date',
    'sowing_count',
    'germination_count',
  ] as const) {
    if (body[key] !== undefined) patch[key] = parsed.value[key] ?? null;
  }
  if (body.notes !== undefined) patch.notes = parsed.value.notes;

  if (Object.keys(patch).length === 0) {
    return errorResponse('VALIDATION_ERROR', { publicMessage: '更新項目がありません。' });
  }

  const rows = await sql`
    update pollenia.sowings set ${sql(patch)}
    where id = ${sowingId}::uuid and user_id = ${user.uid}::uuid
    returning id, seed_harvest_id, sowing_date, sowing_count, germination_count,
              first_germination_date, notes, created_at, updated_at
  `;
  if (rows.length === 0) return errorResponse('NOT_FOUND');
  return json({ sowing: rows[0] });
}

// 日付列・非負整数列・notes の共通パース。
// null は「明示的にクリア」を意味し、そのまま通す（PATCH 用）。
function parseRecordFields(
  body: Record<string, unknown>,
  dateKeys: string[],
  intKeys: string[] = [],
):
  | { ok: true; value: Record<string, string | number | null> & { notes: string | null } }
  | { ok: false; response: Response } {
  const value: Record<string, string | number | null> = {};

  for (const key of dateKeys) {
    if (body[key] === undefined || body[key] === null) continue;
    const d = asDateStr(body[key]);
    if (!d) {
      return {
        ok: false,
        response: errorResponse('VALIDATION_ERROR', { publicMessage: `${key} は YYYY-MM-DD。` }),
      };
    }
    value[key] = d;
  }

  for (const key of intKeys) {
    if (body[key] === undefined || body[key] === null) continue;
    const n = asNonNegInt(body[key]);
    if (n === null) {
      return {
        ok: false,
        response: errorResponse('VALIDATION_ERROR', { publicMessage: `${key} は 0 以上の整数。` }),
      };
    }
    value[key] = n;
  }

  let notes: string | null = null;
  if (body.notes !== undefined && body.notes !== null) {
    notes = asText(body.notes, MAX_TEXT_LEN);
    if (!notes) {
      return {
        ok: false,
        response: errorResponse('VALIDATION_ERROR', { publicMessage: 'notes が不正です。' }),
      };
    }
  }

  return { ok: true, value: { ...value, notes } };
}
