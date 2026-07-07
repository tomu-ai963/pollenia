import type { SupabaseClient } from '@supabase/supabase-js';
import type { Sql } from '../lib/db';
import { json } from '../lib/http';
import { errorResponse } from '../lib/error-response';
import { authenticateJwt, type AuthedUser } from '../lib/auth';
import { asText } from '../lib/validate';
import { MAX_NAME_LEN, MAX_TEXT_LEN } from '../constants';

// POST /api/profiles — Pollenia への初回登録（profiles 行の作成）。
// 「有効な JWT ≠ Pollenia ユーザー」（README「掟」5）の登録側の入口。
// JWT 検証のみ（authenticateJwt）で受け、profiles 行を自分の uid で作る。
// 既に登録済みなら既存行を 200 で返す（冪等）。
// Request: { display_name: string, bio?: string }
export async function handleCreateProfile(
  req: Request,
  supabase: SupabaseClient,
  sql: Sql,
): Promise<Response> {
  const auth = await authenticateJwt(req, supabase);
  if (!auth.ok) return auth.response;
  const uid = auth.value.uid;

  const body = (await req.json().catch(() => null)) as
    | { display_name?: unknown; bio?: unknown }
    | null;
  const displayName = asText(body?.display_name, MAX_NAME_LEN);
  if (!displayName) {
    return errorResponse('VALIDATION_ERROR', {
      publicMessage: `display_name は必須です（${MAX_NAME_LEN}文字以内）。`,
    });
  }
  const bio = body?.bio === undefined ? null : asText(body.bio, MAX_TEXT_LEN);
  if (body?.bio !== undefined && bio === null) {
    return errorResponse('VALIDATION_ERROR', { publicMessage: 'bio が不正です。' });
  }

  const inserted = await sql`
    insert into pollenia.profiles (id, display_name, bio)
    values (${uid}::uuid, ${displayName}, ${bio})
    on conflict (id) do nothing
    returning id, display_name, bio, avatar_path, created_at
  `;
  if (inserted.length > 0) return json({ profile: inserted[0] }, 201);

  // 登録済み → 既存を返す（display_name の上書きはしない。変更は将来の PATCH で）
  const existing = await sql`
    select id, display_name, bio, avatar_path, created_at
    from pollenia.profiles where id = ${uid}::uuid
  `;
  return json({ profile: existing[0] }, 200);
}

// GET /api/me — 自分のプロフィール。
export async function handleGetMe(sql: Sql, user: AuthedUser): Promise<Response> {
  const rows = await sql`
    select id, display_name, bio, avatar_path, created_at, updated_at
    from pollenia.profiles where id = ${user.uid}::uuid
  `;
  if (rows.length === 0) return errorResponse('NOT_FOUND');
  return json({ profile: rows[0] });
}
