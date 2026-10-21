// Worker に注入される環境変数（ローカルは .dev.vars、本番は wrangler secret）。
// コードに値を直書きしないこと。
export interface Env {
  // DB（Neon）への全アクセスは postgres.js で行う（認証テーブル auth_* も同じ接続）。
  //
  // 接続先の解決順（lib/db.ts）:
  //   1. HYPERDRIVE.connectionString — 本番の正規経路（wrangler.toml のバインディング）。
  //      ローカルの wrangler dev では localConnectionString（または
  //      CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE）がここに注入される。
  //      workers-auth の pg ストアの要件で、Hyperdrive はクエリキャッシュ無効（--caching-disabled）で作る。
  //   2. DATABASE_URL — バインディングなしで動かすときのフォールバック。
  HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;

  // --- 静的フロント（frontend/）。wrangler.toml の [assets] ---
  ASSETS?: Fetcher;

  // --- 写真（R2。キーは Worker が採番。閲覧は lib/photos.ts の署名付き URL） ---
  PHOTOS: R2Bucket;

  // --- ログイン（workers-auth deviceAuth: メールコード → 信頼済み端末 + PIN） ---
  // 32 文字以上・十分なエントロピー（SDK が構築時に検査する）。写真 URL の署名鍵もここから
  // HKDF で派生させる（lib/photos.ts）。生成: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
  DEVICE_AUTH_SECRET?: string;
  // ローテーション中の旧シークレット（カンマ区切り）。新しい値に切り替えた後もしばらく残す。
  DEVICE_AUTH_PREVIOUS_SECRETS?: string;
  // メール送信（Resend）。送信元は tomu-ai.dev のアドレス（例: "Pollenia <noreply@tomu-ai.dev>"）。
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  // ローカル専用。"1" でログインコードを Worker のログに出す。リクエストのホストが
  // localhost / 127.0.0.1 のときしか効かない（本番に紛れ込んでもコードはログに出ない）。
  MOCK_MAIL?: string;
  // PIN の PBKDF2 反復回数（1,000〜100,000。既定 100,000）。テスト・ローカルで下げる用。
  PIN_PBKDF2_ITERATIONS?: string;

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
