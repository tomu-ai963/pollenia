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
  // --- Phase 3: AI（育種相談・出品文生成） ---
  // Anthropic API の呼び出しは必ず Worker 経由（フロントにキーを渡さない）。
  // 未設定の環境では /api/ai/* が 500（詳細はログのみ）になる。
  ANTHROPIC_API_KEY?: string;
  // 任意: あれば対応する埋め込みプロバイダーを使用。無ければ mock（ローカル動作確認用）。
  // knowledge-rag の embeddings provider 構成と同じ（lib/ai/embeddings.ts）。
  OPENAI_API_KEY?: string;
  VOYAGE_API_KEY?: string;
  // --- Phase 4: 課金（Stripe） ---
  // Stripe のシークレット・ID はコードに直書きしない（ローカル .dev.vars、本番 wrangler secret）。
  // 未設定だと /api/billing/* が 500 になる（他機能には影響しない）。
  STRIPE_SECRET_KEY?: string;
  // Webhook の署名検証に使う endpoint secret（whsec_...）。
  STRIPE_WEBHOOK_SECRET?: string;
  // 円建て月次サブスクの Price ID（price_...）。テストモードの ID で可。
  STRIPE_PRICE_ID?: string;
  // Checkout 完了/中断後のリダイレクト先（フロントの絶対 URL）。
  // 未設定時は lib/stripe.ts のローカル既定にフォールバック。
  STRIPE_SUCCESS_URL?: string;
  STRIPE_CANCEL_URL?: string;
  // Customer Portal（解約・支払い方法変更）から戻るときのリダイレクト先。
  // 未設定時は lib 側のローカル既定にフォールバック。
  STRIPE_PORTAL_RETURN_URL?: string;
}
