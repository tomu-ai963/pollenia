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
