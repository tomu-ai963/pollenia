-- Phase 3: 育種相談AI（RAG）+ 出品文生成の永続化層
--
-- 方針:
--   * knowledge-rag の pgvector 構成（chunks テーブル + コサイン近傍検索）を踏襲する。
--     ただし knowledge-rag は supabase-js(RPC) 経由だったのに対し、Pollenia の Worker は
--     postgres.js の TCP 直接続（README「掟」6）なので、近傍検索は RPC ではなく
--     Worker からの素の SQL（lib/ai/rag.ts に集約。必ず user_id で絞る）で行う。
--     このため match_* RPC は作らない（露出面を増やさない）。
--   * チャンクは「ユーザー自身の plants / crossings / seed_harvests / sowings」の
--     正規化テキスト。posts / comments は対象外（プロダクト方針）。
--   * 同期はチャット時の遅延同期（Worker が content_hash を比較して差分のみ再埋め込み）。
--     このため (user_id, source_type, source_id) を一意にする。
--   * ai_usage_events は Anthropic API 呼び出しのレート制限・利用量把握の元データ。

-- pgvector。tomu-system の共有DBでまだ有効化されていない前提で有効化する。
-- 既に有効なら no-op（インストール先スキーマも既存のまま変わらない）。
-- Supabase では extensions スキーマに入ることがあるが、search_path 経由で
-- vector 型・<=> 演算子は解決される（ローカル supabase start で確認済みであること）。
create extension if not exists vector;

-- ============================================================
-- ai_chunks: RAG 検索対象（ユーザー自身の記録の正規化テキスト + 埋め込み）
-- ============================================================
create table pollenia.ai_chunks (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references pollenia.profiles (id) on delete cascade,
  -- 参照元。posts/comments は含めない（CHECK で物理的に排除）
  source_type  text not null check (source_type in ('plant', 'crossing', 'seed_harvest', 'sowing')),
  source_id    uuid not null,
  content      text not null,
  -- content の SHA-256（hex）。差分検知用（同一なら再埋め込みしない）
  content_hash text not null,
  -- 1536 次元（knowledge-rag と同じ。embeddings provider 側で次元を揃える）
  embedding    vector(1536),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, source_type, source_id)
);

-- 検索は常に user_id で絞る（他ユーザーのチャンクを読ませない前提のインデックス）。
create index idx_ai_chunks_user on pollenia.ai_chunks (user_id);

-- ベクトルインデックス（ivfflat 等）は張らない。検索は user_id で絞った後の
-- 少量データ（1ユーザー数百件想定）の seq scan で十分正確・高速なため。
-- ユーザー単位のデータが数万件級になったら partial/ivfflat を検討する。

create trigger trg_ai_chunks_updated before update on pollenia.ai_chunks
  for each row execute function pollenia.set_updated_at();

-- ============================================================
-- ai_usage_events: AI 呼び出しの利用ログ（レート制限・コスト把握）
-- ============================================================
create table pollenia.ai_usage_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references pollenia.profiles (id) on delete cascade,
  kind       text not null check (kind in ('consult', 'listing')),
  created_at timestamptz not null default now()
);

-- レート制限判定（直近1分・当日）の count 用。
create index idx_ai_usage_user_created on pollenia.ai_usage_events (user_id, created_at desc);

-- ============================================================
-- RLS: 0002 と同じ deny-all（RLS 有効 + ポリシー無し）。
-- 実運用の認可は Worker（postgres.js 直接続）が担い、RLS は defense in depth。
-- pollenia スキーマは PostgREST 非露出を維持するため GRANT も追加しない。
-- ============================================================
alter table pollenia.ai_chunks       enable row level security;
alter table pollenia.ai_usage_events enable row level security;
