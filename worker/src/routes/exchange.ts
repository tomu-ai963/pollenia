import type { Sql } from '../lib/db';
import { json } from '../lib/http';
import { errorResponse } from '../lib/error-response';
import type { AuthedUser } from '../lib/auth';
import { asText, clampIntParam, isUuid } from '../lib/validate';
import { todayJst } from '../lib/digest';
import { EXCHANGE_PAGE_SIZE, MAX_NAME_LEN, MAX_POST_LEN } from '../constants';
import { POST_COLS, serializePosts } from './posts';

// 種・花粉の交換の希望（0007_genre_seed_exchange.sql）。交換の希望は投稿（posts）の一種で、
// コメント・いいね・公開範囲の判定は投稿と同じ。やりとり（送り方・お礼など）はコメントで、
// 取引・支払いはアプリの外。どちらも visibility = public で作る。
//
// - GET   /api/exchange?type=offer|want&offset=N … 受付中の交換の希望（新しい順）
// - POST  /api/exchange                         … 作成
//     譲ります:   { type: 'offer', stock_id, content, confirm_variety: true }
//     探しています: { type: 'want', label, kind?, species?, content }
// - PATCH /api/exchange/:post_id                … { status: 'open' | 'closed' }（本人だけ）
//
// 「譲ります」は在庫（所有者のみのデータ）から、その時点の名前・種類・属種・期限を投稿にコピーする。
// 在庫そのものは他人に見せない（seed_stock_id は本人にだけ返す。serializePosts）。
// 種苗法: 登録品種の種苗を育成者の許諾なく譲渡すると育成者権の侵害になるため、「譲ります」は
// 本人が「登録品種でない（または許諾がある）」ことを確かめた印（confirm_variety: true）を必須にする。

export async function handleListExchange(req: Request, sql: Sql, user: AuthedUser): Promise<Response> {
  const url = new URL(req.url);
  const type = url.searchParams.get('type') === 'want' ? 'want' : 'offer';
  const offset = clampIntParam(url.searchParams.get('offset'), 0, 1000, 0);
  const rows = await sql`
    select ${sql.unsafe(POST_COLS)} from pollenia.posts
    where exchange_type = ${type} and exchange_status = 'open' and visibility = 'public'
    order by created_at desc
    limit ${EXCHANGE_PAGE_SIZE} offset ${offset}
  `;
  return json({ posts: await serializePosts(sql, user.uid, rows) });
}

export async function handleCreateExchange(req: Request, sql: Sql, user: AuthedUser): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return errorResponse('VALIDATION_ERROR', { publicMessage: 'JSON ボディが必要です。' });
  const content = asText(body.content, MAX_POST_LEN);
  if (!content) {
    return errorResponse('VALIDATION_ERROR', { publicMessage: `本文は必須です（${MAX_POST_LEN}文字以内）。` });
  }

  let item: { kind: string | null; label: string; species: string | null; use_by: string | null; stockId: string | null };
  if (body.type === 'offer') {
    if (body.confirm_variety !== true) {
      return errorResponse('VALIDATION_ERROR', {
        publicMessage:
          '登録品種でないこと（または育成者の許諾があること）を確かめてから出してください。登録品種の種苗を許諾なく譲ることは種苗法で禁じられています。',
      });
    }
    if (!isUuid(body.stock_id)) return errorResponse('VALIDATION_ERROR', { publicMessage: '在庫を選んでください。' });
    const [stock] = await sql`
      select id, kind, label, species, use_by::text as use_by, quantity from pollenia.seed_stocks
      where id = ${body.stock_id}::uuid and user_id = ${user.uid}::uuid
    `;
    if (!stock) return errorResponse('VALIDATION_ERROR', { publicMessage: '在庫は自分のものだけを選べます。' });
    if (stock.use_by && (stock.use_by as string) < todayJst()) {
      return errorResponse('VALIDATION_ERROR', { publicMessage: '使用期限を過ぎた在庫は交換に出せません。' });
    }
    if (stock.quantity === 0) {
      return errorResponse('VALIDATION_ERROR', { publicMessage: '数量が 0 の在庫は交換に出せません。' });
    }
    item = {
      kind: stock.kind as string,
      label: stock.label as string,
      species: (stock.species as string | null) ?? null,
      use_by: (stock.use_by as string | null) ?? null,
      stockId: stock.id as string,
    };
  } else if (body.type === 'want') {
    const label = asText(body.label, MAX_NAME_LEN);
    if (!label) {
      return errorResponse('VALIDATION_ERROR', { publicMessage: `探しているものの名前は必須です（${MAX_NAME_LEN}文字以内）。` });
    }
    if (body.kind !== undefined && body.kind !== null && body.kind !== 'seed' && body.kind !== 'pollen') {
      return errorResponse('VALIDATION_ERROR', { publicMessage: 'kind は seed（種）か pollen（花粉）です。' });
    }
    const species = body.species === undefined || body.species === null || body.species === '' ? null : asText(body.species, MAX_NAME_LEN);
    if (body.species && !species) return errorResponse('VALIDATION_ERROR', { publicMessage: '属・種が長すぎます。' });
    item = { kind: (body.kind as string | null | undefined) ?? null, label, species, use_by: null, stockId: null };
  } else {
    return errorResponse('VALIDATION_ERROR', { publicMessage: 'type は offer（譲ります）か want（探しています）です。' });
  }

  const rows = await sql`
    insert into pollenia.posts
      (user_id, content, visibility, exchange_type, exchange_status, exchange_kind, exchange_label,
       exchange_species, exchange_use_by, seed_stock_id)
    values (${user.uid}::uuid, ${content}, 'public', ${body.type as string}, 'open', ${item.kind}, ${item.label},
            ${item.species}, ${item.use_by}, ${item.stockId})
    returning ${sql.unsafe(POST_COLS)}
  `;
  const [post] = await serializePosts(sql, user.uid, rows);
  return json({ post }, 201);
}

export async function handleUpdateExchange(
  req: Request,
  sql: Sql,
  user: AuthedUser,
  postId: string,
): Promise<Response> {
  if (!isUuid(postId)) return errorResponse('NOT_FOUND');
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (body?.status !== 'open' && body?.status !== 'closed') {
    return errorResponse('VALIDATION_ERROR', { publicMessage: 'status は open（受付中）か closed（終了）です。' });
  }
  const rows = await sql`
    update pollenia.posts set exchange_status = ${body.status}
    where id = ${postId}::uuid and user_id = ${user.uid}::uuid and exchange_type is not null
    returning id, exchange_status
  `;
  if (rows.length === 0) return errorResponse('NOT_FOUND');
  return json({ id: rows[0].id, status: rows[0].exchange_status });
}
