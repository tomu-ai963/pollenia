// Worker に注入される環境変数（ローカルは .dev.vars、本番は wrangler secret）。
// コードに値を直書きしないこと。
export interface Env {
  // Auth の JWT 検証（auth.getUser）と Storage の署名URL発行にのみ使う。
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  // pollenia スキーマへの全 DB アクセス（テーブル・RPC）は postgres.js で行う。
  // supabase-js の db アクセスは PostgREST 経由であり、pollenia を Exposed schemas に
  // 追加しない方針（README「掟」6）と両立しないため使わない。
  //
  // 接続先の解決順（lib/db.ts）:
  //   1. HYPERDRIVE.connectionString — 本番の正規経路（wrangler.toml のバインディング）。
  //      ローカルの wrangler dev では localConnectionString がここに注入されるため同一コードパス。
  //   2. DATABASE_URL — バインディングなしで動かすときのフォールバック
  //      （単体テスト・Hyperdrive 設定が未作成の環境向け。.dev.vars で設定）。
  HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;
}
