import type { Sql } from '../lib/db';
import { json } from '../lib/http';
import { errorResponse } from '../lib/error-response';
import type { AuthedUser } from '../lib/auth';
import { asDateStr, asNonNegInt, asText, isUuid } from '../lib/validate';
import { LIST_LIMIT_MAX, MAX_NAME_LEN, MAX_TEXT_LEN } from '../constants';

// 種・花粉の在庫（0007_genre_seed_exchange.sql）。所有者のみのデータ（visibility を持たない）。
// すべてのクエリを検証済み uid で絞り、他人の在庫は 404（存在を秘匿）。
//
// - GET    /api/seed-stocks          … 自分の在庫（使用期限の近い順。期限なしは後ろ）
// - POST   /api/seed-stocks          … 登録 { kind, label, species?, crossing_id?, quantity?, collected_on?, use_by?, notes? }
// - PATCH  /api/seed-stocks/:id      … 更新（送った項目だけ。null で消す）
// - DELETE /api/seed-stocks/:id      … 削除（交換に出した投稿は残り、在庫への参照だけ外れる）

const COLS = `id, kind, label, species, crossing_id, quantity, collected_on::text as collected_on,
  use_by::text as use_by, notes, created_at, updated_at`;

type Parsed = { ok: true; patch: Record<string, unknown> } | { ok: false; response: Response };

const bad = (publicMessage: string): Parsed => ({
  ok: false,
  response: errorResponse('VALIDATION_ERROR', { publicMessage }),
});

// 送られた項目だけを検証して patch にする（create は必須項目を呼び出し側で確かめる）
async function parseFields(body: Record<string, unknown>, sql: Sql, uid: string): Promise<Parsed> {
  const patch: Record<string, unknown> = {};
  if (body.kind !== undefined) {
    if (body.kind !== 'seed' && body.kind !== 'pollen') return bad('kind は seed（種）か pollen（花粉）です。');
    patch.kind = body.kind;
  }
  if (body.label !== undefined) {
    const label = asText(body.label, MAX_NAME_LEN);
    if (!label) return bad(`名前は必須です（${MAX_NAME_LEN}文字以内）。`);
    patch.label = label;
  }
  for (const [key, max, name] of [
    ['species', MAX_NAME_LEN, '属・種'],
    ['notes', MAX_TEXT_LEN, 'メモ'],
  ] as const) {
    if (body[key] === undefined) continue;
    if (body[key] === null || body[key] === '') {
      patch[key] = null;
      continue;
    }
    const v = asText(body[key], max);
    if (!v) return bad(`${name}が長すぎます。`);
    patch[key] = v;
  }
  for (const key of ['collected_on', 'use_by'] as const) {
    if (body[key] === undefined) continue;
    if (body[key] === null || body[key] === '') {
      patch[key] = null;
      continue;
    }
    const d = asDateStr(body[key]);
    if (!d) return bad(`${key === 'use_by' ? '使用期限' : '採取日'}は YYYY-MM-DD で指定してください。`);
    patch[key] = d;
  }
  if (body.quantity !== undefined) {
    if (body.quantity === null) patch.quantity = null;
    else {
      const q = asNonNegInt(body.quantity);
      if (q === null) return bad('数量は 0 以上の整数です。');
      patch.quantity = q;
    }
  }
  if (body.crossing_id !== undefined) {
    if (body.crossing_id === null) patch.crossing_id = null;
    else {
      if (!isUuid(body.crossing_id)) return bad('crossing_id が不正です。');
      const own = await sql`
        select 1 from pollenia.crossings where id = ${body.crossing_id}::uuid and user_id = ${uid}::uuid
      `;
      if (own.length === 0) return bad('交配は自分の記録だけを選べます。');
      patch.crossing_id = body.crossing_id;
    }
  }
  return { ok: true, patch };
}

export async function handleListSeedStocks(sql: Sql, user: AuthedUser): Promise<Response> {
  const stocks = await sql`
    select ${sql.unsafe(COLS)} from pollenia.seed_stocks
    where user_id = ${user.uid}::uuid
    order by use_by asc nulls last, created_at desc
    limit ${LIST_LIMIT_MAX}
  `;
  return json({ stocks });
}

export async function handleCreateSeedStock(req: Request, sql: Sql, user: AuthedUser): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return errorResponse('VALIDATION_ERROR', { publicMessage: 'JSON ボディが必要です。' });
  if (body.kind === undefined || body.label === undefined) {
    return errorResponse('VALIDATION_ERROR', { publicMessage: '種類（種・花粉）と名前は必須です。' });
  }
  const parsed = await parseFields(body, sql, user.uid);
  if (!parsed.ok) return parsed.response;
  const rows = await sql`
    insert into pollenia.seed_stocks ${sql({ user_id: user.uid, ...parsed.patch })}
    returning ${sql.unsafe(COLS)}
  `;
  return json({ stock: rows[0] }, 201);
}

export async function handleUpdateSeedStock(
  req: Request,
  sql: Sql,
  user: AuthedUser,
  id: string,
): Promise<Response> {
  if (!isUuid(id)) return errorResponse('NOT_FOUND');
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return errorResponse('VALIDATION_ERROR', { publicMessage: 'JSON ボディが必要です。' });
  const parsed = await parseFields(body, sql, user.uid);
  if (!parsed.ok) return parsed.response;
  if (Object.keys(parsed.patch).length === 0) {
    return errorResponse('VALIDATION_ERROR', { publicMessage: '更新項目がありません。' });
  }
  const rows = await sql`
    update pollenia.seed_stocks set ${sql(parsed.patch)}
    where id = ${id}::uuid and user_id = ${user.uid}::uuid
    returning ${sql.unsafe(COLS)}
  `;
  if (rows.length === 0) return errorResponse('NOT_FOUND');
  return json({ stock: rows[0] });
}

export async function handleDeleteSeedStock(sql: Sql, user: AuthedUser, id: string): Promise<Response> {
  if (!isUuid(id)) return errorResponse('NOT_FOUND');
  const rows = await sql`
    delete from pollenia.seed_stocks where id = ${id}::uuid and user_id = ${user.uid}::uuid returning id
  `;
  if (rows.length === 0) return errorResponse('NOT_FOUND');
  return json({ ok: true, id: rows[0].id });
}
