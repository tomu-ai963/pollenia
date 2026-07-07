import type { SupabaseClient } from '@supabase/supabase-js';
import type { Sql } from './db';
import { errorResponse } from './error-response';

// Supabase Auth の JWT を検証し、Pollenia ユーザーへ解決する。
//
// 重要（README「掟」5）: tomu-system は Auth レルム（auth.users・JWT シークレット）を
// 全テナントで共有するため、**有効な JWT ≠ Pollenia ユーザー**。
// B2B 側（contract-review 等）向けに発行された JWT も検証は通ってしまう。
// 必ず pollenia.profiles 行の存在で「Pollenia のユーザーか」を判定すること。

export interface AuthedUser {
  uid: string;
  displayName: string;
}

export type AuthResult<T> = { ok: true; value: T } | { ok: false; response: Response };

function extractBearer(req: Request): string | null {
  const header = req.headers.get('authorization') ?? '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// 段階1: JWT の検証のみ（uid を返す）。profiles 行はまだ要求しない。
// 用途は POST /api/profiles（初回登録）だけ。他のエンドポイントは authenticateUser を使うこと。
export async function authenticateJwt(
  req: Request,
  supabase: SupabaseClient,
): Promise<AuthResult<{ uid: string }>> {
  const token = extractBearer(req);
  if (!token) {
    return {
      ok: false,
      response: errorResponse('AUTH_FAILED', {
        publicMessage: 'Authorization: Bearer トークンが必要です。',
      }),
    };
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return {
      ok: false,
      response: errorResponse('AUTH_FAILED', {
        detail: error ?? 'auth.getUser returned no user',
        publicMessage: 'トークンが無効です。',
      }),
    };
  }
  return { ok: true, value: { uid: data.user.id } };
}

// 段階2: JWT 検証 + pollenia.profiles 行の存在確認（通常の /api/* はこちら）。
export async function authenticateUser(
  req: Request,
  supabase: SupabaseClient,
  sql: Sql,
): Promise<AuthResult<AuthedUser>> {
  const jwt = await authenticateJwt(req, supabase);
  if (!jwt.ok) return jwt;

  const rows = await sql`
    select id, display_name from pollenia.profiles where id = ${jwt.value.uid}::uuid
  `;
  if (rows.length === 0) {
    // JWT は有効だが Pollenia 未登録（他プロダクトのユーザー含む）。
    return {
      ok: false,
      response: errorResponse('FORBIDDEN', {
        publicMessage: 'Pollenia のユーザー登録が必要です（POST /api/profiles）。',
      }),
    };
  }
  return { ok: true, value: { uid: rows[0].id, displayName: rows[0].display_name } };
}
