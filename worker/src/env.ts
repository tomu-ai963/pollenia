// Worker に注入される環境変数（ローカルは .dev.vars、本番は wrangler secret）。
// コードに値を直書きしないこと。
export interface Env {
  // Auth の JWT 検証（auth.getUser）と Storage の署名URL発行にのみ使う。
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  // pollenia スキーマへの全 DB アクセス（テーブル・RPC）は postgres.js の TCP 直接続で行う。
  // supabase-js の db アクセスは PostgREST 経由であり、pollenia を Exposed schemas に
  // 追加しない方針（README「掟」6）と両立しないため使わない。
  // ローカル: supabase start の 127.0.0.1:54322 / 本番: Supavisor transaction pooler (6543)。
  DATABASE_URL: string;
}
