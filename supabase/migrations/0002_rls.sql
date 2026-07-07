-- Pollenia RLS 方針
--
-- アクセス経路は既存B2Bプロジェクト（contract-review 等）と同型:
--   フロント → Worker（認可ロジック） → Supabase（service_role）
-- service_role は RLS をバイパスするため、実運用の認可は Worker + RPC が担う。
-- ここでの RLS は defense in depth（anon キー漏洩・PostgREST 直叩き対策）で、
-- 全テーブル RLS 有効 + ポリシー無し = deny-all から始める。
--
-- Phase 2 でフィード等をフロント直読みに切り替える場合は、末尾のコメントの
-- 読み取りポリシーを有効化する。
--
-- ※ 重要（Opus レビュー反映）: Phase 1 では pollenia を PostgREST の Exposed schemas に
--   追加しないこと。追加＋grant を行うと deny-all RLS があっても、ビュー(security_invoker で
--   是正済)や PUBLIC 権限の残る関数経由でバイパスされうる。RPC も Worker が service_role で
--   呼べば露出は不要。露出は Phase 2 で、テーブル/ビュー/関数ごとの明示 GRANT 設計とセットで行う。

alter table pollenia.profiles      enable row level security;
alter table pollenia.plants        enable row level security;
alter table pollenia.crossings     enable row level security;
alter table pollenia.seed_harvests enable row level security;
alter table pollenia.sowings       enable row level security;
alter table pollenia.plant_photos  enable row level security;
alter table pollenia.posts         enable row level security;
alter table pollenia.follows       enable row level security;
alter table pollenia.likes         enable row level security;
alter table pollenia.comments      enable row level security;

-- RLS ポリシー用の可視性判定（auth.uid() を viewer とする薄いラッパ）。
-- 実体は 0001 の can_view_as。search_path に public を含めない（definer 関数の
-- search_path への public 混入は、共有DB では関数/演算子シャドウイングの昇格面になる）。
-- 既定の PUBLIC EXECUTE は剥奪し、ポリシー評価に必要な authenticated にだけ付与する。
create or replace function pollenia.can_view(p_owner uuid, p_visibility pollenia.visibility)
returns boolean
language sql
stable
security definer
set search_path = pollenia, pg_catalog
as $$
  select pollenia.can_view_as(auth.uid(), p_owner, p_visibility)
$$;

revoke execute on function pollenia.can_view(uuid, pollenia.visibility) from public;
grant  execute on function pollenia.can_view(uuid, pollenia.visibility) to authenticated;

-- ============================================================
-- Phase 2（フロント直読み解禁）で有効化するポリシーの下書き
-- ============================================================
-- 方針:
--   * plants / posts … can_view() で公開範囲を制御
--   * profiles … visibility 列を持たない。display_name/bio/avatar は公開前提なので
--     select は全 authenticated 許可（can_view は使わない）。将来非公開化するなら列追加。
--   * plant_photos … 親 plant の可視性に従う（下記 plant_photos_select）。
--     単体では visibility を持たないので必ず plants へ join して判定する。
--   * crossings / seed_harvests / sowings … RLS 上は所有者のみ。
--     他人の系統の閲覧は get_ancestors/get_descendants RPC（security definer で
--     can_view_as により刈り込む）経由に限定し、生テーブルは開けない。
--     ※ 親2個体の visibility が食い違う交配（片親 private）を生テーブルの
--       行単位ポリシーで正しく表現できないため。
--   * 書き込みは全テーブル owner のみ（with check (user_id = auth.uid())）
--
-- create policy plants_select on pollenia.plants for select
--   to authenticated
--   using (deleted_at is null and pollenia.can_view(user_id, visibility));
--
-- create policy plants_write on pollenia.plants for all
--   to authenticated
--   using (user_id = auth.uid())
--   with check (user_id = auth.uid());
--
-- create policy posts_select on pollenia.posts for select
--   to authenticated
--   using (pollenia.can_view(user_id, visibility));
--
-- create policy profiles_select on pollenia.profiles for select
--   to authenticated using (true);   -- 公開プロフィール（非公開列は持たせない）
--
-- create policy plant_photos_select on pollenia.plant_photos for select
--   to authenticated
--   using (exists (select 1 from pollenia.plants p
--                  where p.id = plant_id
--                    and p.deleted_at is null
--                    and pollenia.can_view(p.user_id, p.visibility)));
--
-- create policy follows_select on pollenia.follows for select
--   to authenticated
--   using (follower_id = auth.uid() or followee_id = auth.uid());
--
-- create policy follows_write on pollenia.follows for all
--   to authenticated
--   using (follower_id = auth.uid())
--   with check (follower_id = auth.uid());
--
-- likes / comments は「親 post が見えるなら書ける・見える」:
--   using (exists (select 1 from pollenia.posts p
--                  where p.id = post_id
--                    and pollenia.can_view(p.user_id, p.visibility)))
