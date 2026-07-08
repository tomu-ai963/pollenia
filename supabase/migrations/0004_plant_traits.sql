-- Phase 3（育種相談AI）前段: plants に構造化特性 traits（JSONB）を追加する。
--
-- 目的:
--   自由記述の notes は残したまま、AIが集計・比較しやすい「値」を持つ項目だけを
--   traits に分離する。個別カラムではなく JSONB 一本にまとめることで、今後 traits の
--   項目が増えてもマイグレーション不要にする（初期段階でスキーマを固めすぎない）。
--
-- 方針:
--   * 全項目任意入力。traits 自体も空（{}）を許容し、記録のハードルを上げない。
--     既定を '{}' にすることで既存個体は空のまま backfill され（scope 外の一括移行は不要）、
--     新規個体も未入力なら {} になる。read 側で null 分岐を持たずに済むよう not null にする。
--   * 可視性は plants の visibility 列（public/followers/private）にそのまま従う。
--     traits 単体の別ルール・別 RLS は設けない（0002 の deny-all を維持。認可は Worker が担う）。
--   * defense in depth: traits は必ず JSON オブジェクトであることを CHECK で保証する。
--     書き込みは常に Worker（lib/traits.ts で既知キーのみに正規化）を介在させる前提だが、
--     将来別経路が入っても配列・スカラ・不定形が紛れ込まないようにする。
--
-- ※ 0002 の deny-all RLS は列追加では変化しない（列レベルのポリシーは無く、行単位で deny）。
--   pollenia スキーマは PostgREST 非露出のままで、traits も Worker 経由でのみ読み書きされる。

alter table pollenia.plants
  add column traits jsonb not null default '{}'::jsonb
    check (jsonb_typeof(traits) = 'object');
