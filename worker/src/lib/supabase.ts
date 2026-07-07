import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../env';

// supabase-js クライアント。用途は Auth の JWT 検証（auth.getUser）と
// Storage の署名URL発行のみ。DB アクセスには使わないこと（lib/db.ts のコメント参照）。
export function createSupabase(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}
