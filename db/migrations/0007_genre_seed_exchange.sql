-- 0007: ジャンル別の記録項目・種と花粉の在庫・交換の希望（2026-11-27）。

-- ---- ジャンル（入力する特性の項目が変わる。項目の定義は frontend/src/trait-spec.js）----
-- null はこれまでの個体（「その他」と同じ項目を出す）。
alter table pollenia.plants
  add column genre text check (genre in ('rose', 'hellebore', 'succulent', 'vegetable', 'other'));

-- ---- 種・花粉の在庫（所有者のみのデータ。visibility を持たない）----
create table pollenia.seed_stocks (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references pollenia.profiles (id) on delete cascade,
  kind         text not null check (kind in ('seed', 'pollen')),
  label        text not null,                 -- 「ピンク実生×青の香り 2025」など、本人が付ける名前
  species      text,
  crossing_id  uuid references pollenia.crossings (id) on delete set null,  -- 自分の交配から取ったもの
  quantity     integer check (quantity >= 0), -- 粒数（花粉は任意）
  collected_on date,
  use_by       date,                          -- 使用期限（発芽率・花粉の活力が落ちる頃）
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index seed_stocks_user_idx on pollenia.seed_stocks (user_id, created_at desc);
alter table pollenia.seed_stocks enable row level security;  -- deny-all（Worker 経由のみ。0001 と同じ方針）

create trigger trg_seed_stocks_updated before update on pollenia.seed_stocks
  for each row execute function pollenia.set_updated_at();

-- ---- 交換の希望（投稿の一種。コメント・いいね・公開範囲の判定は投稿と同じ）----
-- 「譲ります」（offer）は在庫から作り、その時点の名前・種類・属種・期限を投稿にコピーする
-- （在庫は所有者のみのデータなので、他人には在庫そのものを見せない。seed_stock_id は本人にだけ返す）。
-- 「探しています」（want）は在庫なし。どちらも visibility = public で作る。
alter table pollenia.posts
  add column exchange_type    text check (exchange_type in ('offer', 'want')),
  add column exchange_status  text check (exchange_status in ('open', 'closed')),
  add column exchange_kind    text check (exchange_kind in ('seed', 'pollen')),
  add column exchange_label   text,
  add column exchange_species text,
  add column exchange_use_by  date,
  add column seed_stock_id    uuid references pollenia.seed_stocks (id) on delete set null,
  add constraint posts_exchange_consistent check (
    (exchange_type is null and exchange_status is null)
    or (exchange_type is not null and exchange_status is not null and exchange_label is not null)
  );
create index posts_exchange_idx on pollenia.posts (exchange_type, created_at desc)
  where exchange_type is not null and exchange_status = 'open' and visibility = 'public';
