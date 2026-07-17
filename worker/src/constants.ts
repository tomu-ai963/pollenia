// 動作パラメータの集約。★印は Phase 1 での仮決め値（プラン設計・運用で見直す前提）。

// 系統樹の世代数。SQL 関数側の default (10) と MAX を一致させる。
// ★無料/有料のプラン差（無料=2世代 等）は課金導入（Phase 3）まで未実装。
//   Phase 1 は全ユーザー同一で depth をクライアント指定可・Worker がクランプする。
export const LINEAGE_DEPTH_DEFAULT = 5;
export const LINEAGE_DEPTH_MAX = 10;

// 公開系統ページ（認証不要）は depth 固定。★仮決め。
export const PUBLIC_LINEAGE_DEPTH = 5;

// 公開ページの Cache-Control max-age（秒）。visibility を private に戻した際の
// 伝播遅延の許容値でもあるため長くしない。★仮決め。
export const PUBLIC_CACHE_SECONDS = 60;

// 一覧系のページネーション上限。
export const LIST_LIMIT_DEFAULT = 50;
export const LIST_LIMIT_MAX = 100;

// Storage。バケットは pollenia- prefix 必須（README「掟」3）。
export const PHOTO_BUCKET = 'pollenia-photos';
export const PHOTO_SIGNED_URL_SECONDS = 3600;

// 受け付ける画像の content-type → 拡張子。
export const PHOTO_CONTENT_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// テキスト入力の上限（暴発防止）。
export const MAX_NAME_LEN = 200;
export const MAX_TEXT_LEN = 10_000;

// plants.traits（構造化特性・Phase 3 前段）。全項目任意入力。
// 項目追加はこの定数＋lib/traits.ts＋フロントの更新で完結し、DB マイグレーションは不要。
export const BLOOM_SEASONS = ['spring', 'early_summer', 'summer', 'autumn', 'winter'] as const;
export type BloomSeason = (typeof BLOOM_SEASONS)[number];

// 数値項目の上限（暴発防止）。下限は 0 より大（0/負値は未入力扱いにさせない）。
export const TRAIT_MAX_HEIGHT_CM = 10_000; // 100m。園芸個体としては十分な余裕
export const TRAIT_MAX_FLOWER_CM = 1_000;
// 香りの強さは 0〜5 の整数。
export const TRAIT_FRAGRANCE_STRENGTH_MAX = 5;

// コミュニティ（Phase 2）。★仮決め。
export const MAX_POST_LEN = 5_000;
export const MAX_COMMENT_LEN = 2_000;

// ============================================================
// AI（Phase 3: 育種相談・出品文生成）。★印は仮決め（運用で見直す前提）。
// ============================================================

// Anthropic API のモデル。有料化（Phase 4）に合わせて Sonnet 5 + effort=medium に変更
// （コスト最適化。品質と料金のバランス。output_config.effort で思考深度を制御）。
export const AI_MODEL = 'claude-sonnet-5';
// 思考/出力の労力。output_config.effort に渡す（top-level ではない）。adaptive thinking と併用。
export const AI_EFFORT = 'medium';
export const AI_CONSULT_MAX_TOKENS = 2_048;
export const AI_LISTING_MAX_TOKENS = 2_048;

// 埋め込み次元（knowledge-rag と同じ。0005_ai.sql の vector(1536) と一致させる）。
export const EMBEDDING_DIM = 1536;

// RAG 近傍検索の取得件数。★仮決め。
export const AI_TOP_K = 8;

// 遅延同期でチャンク化する記録の上限（テーブルごと・新しい順）。
// リクエストあたりの参照データ量とトークン量を青天井にしないための関門。★仮決め。
export const AI_SYNC_MAX_ROWS_PER_TABLE = 200;
// 一度に埋め込み API へ渡すテキスト数の上限（初回同期の暴発防止）。
export const AI_EMBED_BATCH_SIZE = 100;
// チャンクに含める notes の最大文字数（超過分は切り詰め）。
export const AI_CHUNK_NOTES_MAX = 500;

// 育種相談チャットの入力上限。
export const AI_MESSAGE_MAX_LEN = 2_000;
export const AI_HISTORY_MAX_TURNS = 12;

// レート制限（同一ユーザー）。連投・コスト青天井の防止。★仮決め。
// 有料プラン導入（Phase 4）で「月70回を目安」の月次上限を主軸に据え、
// 分/日は瞬間的な連打・単日暴発のガードとして残す（lib/ai/rate-limit.ts）。
export const AI_RATE_LIMIT_PER_MINUTE = 5;
export const AI_RATE_LIMIT_PER_DAY = 50;
export const AI_RATE_LIMIT_PER_MONTH = 70;

// ============================================================
// 課金（Phase 4: Stripe 月額サブスク）。★印は仮決め。
// ============================================================

// 価格（¥/月）。表示・案内用（実際の課金額は Stripe Price 側が正）。
export const SUBSCRIPTION_PRICE_JPY = 300;

// AI 機能を許可するサブスク状態。past_due は Stripe の自動リトライ猶予中も含める
// （即時停止しない設計。0006_billing.sql / lib/stripe.ts のコメント参照）。
export const SUBSCRIPTION_ENTITLED_STATUSES = ['active', 'past_due'] as const;

// Stripe Webhook 署名検証のタイムスタンプ許容窓（秒）。Stripe 公式デフォルトと同じ 5 分。
// リプレイ攻撃の窓を絞りつつ、正当な遅延配送を弾かない値。
export const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;

// 出品文生成の対象マーケット。
export const AI_MARKETPLACES = ['mercari', 'yahoo_auction'] as const;
export type AiMarketplace = (typeof AI_MARKETPLACES)[number];
// メルカリの商品名上限（プロンプトと出力クランプの両方で使う）。
export const AI_LISTING_TITLE_MAX = 40;
