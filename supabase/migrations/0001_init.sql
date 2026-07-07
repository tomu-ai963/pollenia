-- Pollenia 初期スキーマ
-- tomu-system の Supabase プロジェクトに `pollenia` スキーマとして間借りする。
-- 将来の独立切り出しのため、auth.users への FK は profiles の1箇所に集約し、
-- それ以外のテーブルはすべて pollenia.profiles を参照する。
-- ENUM・関数・ビューもすべて pollenia スキーマ内に定義し、public には何も置かない。

create schema if not exists pollenia;

create type pollenia.visibility as enum ('public', 'followers', 'private');

create or replace function pollenia.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================
-- profiles: auth.users との唯一の接点
-- ============================================================
create table pollenia.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  bio          text,
  avatar_path  text,  -- Supabase Storage のパス（バケットは pollenia- prefix）
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ============================================================
-- 育種記録: plants → crossings → seed_harvests → sowings → plants(昇格)
-- ============================================================

-- plants: 個体。系統はユーザー資産なので物理削除せず deleted_at で soft delete する。
-- origin_sowing_id は後方の sowings 定義後に ALTER で追加（循環参照のため）。
-- NULL = 導入株（購入・譲渡）、非NULL = 自家実生。旧設計の type カラムはこれで導出できるため廃止。
create table pollenia.plants (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references pollenia.profiles (id) on delete cascade,
  name        text not null,
  species     text,  -- 属・種の自由入力。検索需要が出たらマスタテーブル化
  visibility  pollenia.visibility not null default 'private',
  notes       text,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- crossings: 交配記録。
-- seed_parent（母木）は必須、pollen_parent は NULL 可（自然交雑・父不明のケースは実際に多い）。
-- 自家受粉（seed_parent_id = pollen_parent_id）は正当な操作なので許容する。
-- 親個体は系統の根拠なので on delete restrict（plants 側は soft delete が前提）。
create table pollenia.crossings (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references pollenia.profiles (id) on delete cascade,
  seed_parent_id   uuid not null references pollenia.plants (id) on delete restrict,
  pollen_parent_id uuid references pollenia.plants (id) on delete restrict,
  cross_date       date,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table pollenia.seed_harvests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references pollenia.profiles (id) on delete cascade,
  crossing_id  uuid not null references pollenia.crossings (id) on delete cascade,
  harvest_date date,
  seed_count   integer check (seed_count >= 0),
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- sowings: 播種記録。1つの seed_harvest に複数ぶら下がる。
-- germination_count は有料機能「発芽率グラフ」の元データ。無料期間から蓄積しておく必要が
-- あるため初期スキーマに含める（後から足すと過去データが欠損する）。
create table pollenia.sowings (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references pollenia.profiles (id) on delete cascade,
  seed_harvest_id        uuid not null references pollenia.seed_harvests (id) on delete cascade,
  sowing_date            date,
  sowing_count           integer check (sowing_count >= 0),
  germination_count      integer check (germination_count >= 0),
  first_germination_date date,
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- 実生の個体昇格リンク。旧設計の seedlings テーブルは plant_id リンク以外の情報を
-- 持たないため廃止し、plants 側に origin_sowing_id を持たせる（選抜登録派は任意の
-- タイミングで plants を作って sowing に紐付けるだけ）。
alter table pollenia.plants
  add column origin_sowing_id uuid references pollenia.sowings (id) on delete set null;

create table pollenia.plant_photos (
  id           uuid primary key default gen_random_uuid(),
  plant_id     uuid not null references pollenia.plants (id) on delete cascade,
  user_id      uuid not null references pollenia.profiles (id) on delete cascade,
  storage_path text not null,  -- バケット内パス。URL は署名付きで都度発行するため保存しない
  caption      text,
  taken_at     date,
  created_at   timestamptz not null default now()
);

-- ============================================================
-- コミュニティ
-- ============================================================

create table pollenia.posts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references pollenia.profiles (id) on delete cascade,
  crossing_id uuid references pollenia.crossings (id) on delete set null,
  content     text not null,
  visibility  pollenia.visibility not null default 'public',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table pollenia.follows (
  follower_id uuid not null references pollenia.profiles (id) on delete cascade,
  followee_id uuid not null references pollenia.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);

create table pollenia.likes (
  user_id    uuid not null references pollenia.profiles (id) on delete cascade,
  post_id    uuid not null references pollenia.posts (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);

create table pollenia.comments (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references pollenia.posts (id) on delete cascade,
  user_id    uuid not null references pollenia.profiles (id) on delete cascade,
  content    text not null,
  created_at timestamptz not null default now()
);

-- ============================================================
-- インデックス（Postgres は FK に自動でインデックスを張らない）
-- ============================================================

create index idx_plants_user on pollenia.plants (user_id);
create index idx_plants_origin_sowing on pollenia.plants (origin_sowing_id)
  where origin_sowing_id is not null;

-- 系統樹の再帰CTEは母方向・父方向の両方を辿るため両カラムに必要
create index idx_crossings_user on pollenia.crossings (user_id);
create index idx_crossings_seed_parent on pollenia.crossings (seed_parent_id);
create index idx_crossings_pollen_parent on pollenia.crossings (pollen_parent_id)
  where pollen_parent_id is not null;

create index idx_seed_harvests_crossing on pollenia.seed_harvests (crossing_id);
create index idx_seed_harvests_user on pollenia.seed_harvests (user_id);
create index idx_sowings_harvest on pollenia.sowings (seed_harvest_id);
create index idx_sowings_user on pollenia.sowings (user_id);
create index idx_plant_photos_plant on pollenia.plant_photos (plant_id);

create index idx_posts_user on pollenia.posts (user_id);
create index idx_posts_crossing on pollenia.posts (crossing_id)
  where crossing_id is not null;
create index idx_posts_feed on pollenia.posts (created_at desc);
create index idx_follows_followee on pollenia.follows (followee_id);
create index idx_likes_post on pollenia.likes (post_id);
create index idx_comments_post on pollenia.comments (post_id);

-- ============================================================
-- updated_at トリガー
-- ============================================================

create trigger trg_profiles_updated before update on pollenia.profiles
  for each row execute function pollenia.set_updated_at();
create trigger trg_plants_updated before update on pollenia.plants
  for each row execute function pollenia.set_updated_at();
create trigger trg_crossings_updated before update on pollenia.crossings
  for each row execute function pollenia.set_updated_at();
create trigger trg_seed_harvests_updated before update on pollenia.seed_harvests
  for each row execute function pollenia.set_updated_at();
create trigger trg_sowings_updated before update on pollenia.sowings
  for each row execute function pollenia.set_updated_at();
create trigger trg_posts_updated before update on pollenia.posts
  for each row execute function pollenia.set_updated_at();

-- ============================================================
-- 系統樹
-- 1世代 = plant → sowing → seed_harvest → crossing → 両親 の4段JOINになるため、
-- 再帰CTEを単純化するビューを1枚かませる。
-- ============================================================

-- security_invoker=true 必須。省略するとビューは所有者権限で実行され、
-- 配下 plants/crossings の RLS がバイパスされる（PostgREST 直読みで全ユーザーの
-- 交配グラフが漏れる）。invoker にすることで Phase 1 の deny-all 下では anon に対し
-- fail-closed になり、service_role を使う Worker / definer 関数からは従来どおり読める。
create view pollenia.plant_parents
  with (security_invoker = true) as
select
  p.id  as plant_id,
  c.id  as crossing_id,
  c.seed_parent_id,
  c.pollen_parent_id
from pollenia.plants p
join pollenia.sowings s       on s.id = p.origin_sowing_id
join pollenia.seed_harvests h on h.id = s.seed_harvest_id
join pollenia.crossings c     on c.id = h.crossing_id;

-- 可視性判定ヘルパー（明示 viewer 版）。
-- can_view() は auth.uid() を使うが、Worker は service_role で呼ぶため auth.uid()=NULL に
-- なる。系統樹関数は「誰の視点で刈り込むか」を引数で受ける必要があるため、viewer を明示で
-- 取るこちらを土台にする。p_viewer が NULL の呼び出し＝匿名（公開系統ページ）で、public のみ可視。
-- security definer にする理由は can_view() と同じ（followers 判定で follows を読むため）。
create or replace function pollenia.can_view_as(
  p_viewer     uuid,
  p_owner      uuid,
  p_visibility pollenia.visibility
)
returns boolean
language sql
stable
security definer
set search_path = pollenia, pg_catalog
as $$
  select p_visibility = 'public'
      or (p_viewer is not null and p_owner = p_viewer)
      or (p_visibility = 'followers' and p_viewer is not null and exists (
            select 1
            from pollenia.follows f
            where f.followee_id = p_owner
              and f.follower_id = p_viewer
         ))
$$;

-- 祖先方向（この個体の系譜）。
-- security definer にして plants を全件読み、関数内で can_view_as により
-- 「viewer から見えるノードだけ」を通す。非可視の親は ID を返さず NULL 化し、
-- has_hidden_parent = true で「この先に非公開の親がいる」ことだけ伝える（ID・名前は漏らさない）。
-- 呼び出し側（Worker）は返却された可視 plant_id にだけ名前・写真を join すること。
-- p_max_depth は無料プランの世代制限用であって可視性制御ではない。
create or replace function pollenia.get_ancestors(
  p_plant_id  uuid,
  p_viewer    uuid,
  p_max_depth int default 10
)
returns table (
  plant_id          uuid,
  crossing_id       uuid,
  seed_parent_id    uuid,
  pollen_parent_id  uuid,
  depth             int,
  has_hidden_parent boolean
)
language sql
stable
security definer
set search_path = pollenia, pg_catalog
as $$
  with recursive lineage as (
    select
      pp.plant_id,
      pp.crossing_id,
      case when pollenia.can_view_as(p_viewer, sp.user_id, sp.visibility)
           then pp.seed_parent_id end                                    as seed_parent_id,
      case when pp.pollen_parent_id is not null
            and pollenia.can_view_as(p_viewer, fp.user_id, fp.visibility)
           then pp.pollen_parent_id end                                  as pollen_parent_id,
      1 as depth,
      (sp.id is not null and not pollenia.can_view_as(p_viewer, sp.user_id, sp.visibility))
        or (fp.id is not null and not pollenia.can_view_as(p_viewer, fp.user_id, fp.visibility))
                                                                         as has_hidden_parent,
      array[pp.plant_id] as path
    from pollenia.plant_parents pp
    join pollenia.plants root    on root.id = pp.plant_id
    left join pollenia.plants sp on sp.id = pp.seed_parent_id
    left join pollenia.plants fp on fp.id = pp.pollen_parent_id
    where pp.plant_id = p_plant_id
      and pollenia.can_view_as(p_viewer, root.user_id, root.visibility)

    union all

    select
      pp.plant_id,
      pp.crossing_id,
      case when pollenia.can_view_as(p_viewer, sp.user_id, sp.visibility)
           then pp.seed_parent_id end,
      case when pp.pollen_parent_id is not null
            and pollenia.can_view_as(p_viewer, fp.user_id, fp.visibility)
           then pp.pollen_parent_id end,
      l.depth + 1,
      (sp.id is not null and not pollenia.can_view_as(p_viewer, sp.user_id, sp.visibility))
        or (fp.id is not null and not pollenia.can_view_as(p_viewer, fp.user_id, fp.visibility)),
      l.path || pp.plant_id
    from pollenia.plant_parents pp
    join pollenia.plants cur     on cur.id = pp.plant_id
    left join pollenia.plants sp on sp.id = pp.seed_parent_id
    left join pollenia.plants fp on fp.id = pp.pollen_parent_id
    -- 直前行で NULL 化した非可視の親は in (...) に一致せず、そこで辿りが止まる
    join lineage l on pp.plant_id in (l.seed_parent_id, l.pollen_parent_id)
    where l.depth < p_max_depth
      and not (pp.plant_id = any (l.path))
      and pollenia.can_view_as(p_viewer, cur.user_id, cur.visibility)
  )
  select plant_id, crossing_id, seed_parent_id, pollen_parent_id, depth, has_hidden_parent
  from lineage
$$;

-- 子孫方向（この個体から生まれた系統）。
-- 可視な子だけを辿り、非可視の子は返さない（未公開の実生・選抜個体の露出を防ぐ）。
-- 併せて、可視な子が持つ非可視の共同親 ID も NULL 化する（片親だけ private のケース）。
create or replace function pollenia.get_descendants(
  p_plant_id  uuid,
  p_viewer    uuid,
  p_max_depth int default 10
)
returns table (
  plant_id          uuid,
  crossing_id       uuid,
  seed_parent_id    uuid,
  pollen_parent_id  uuid,
  depth             int,
  has_hidden_parent boolean
)
language sql
stable
security definer
set search_path = pollenia, pg_catalog
as $$
  with recursive lineage as (
    select
      pp.plant_id,
      pp.crossing_id,
      case when pollenia.can_view_as(p_viewer, sp.user_id, sp.visibility)
           then pp.seed_parent_id end                                    as seed_parent_id,
      case when pp.pollen_parent_id is not null
            and pollenia.can_view_as(p_viewer, fp.user_id, fp.visibility)
           then pp.pollen_parent_id end                                  as pollen_parent_id,
      1 as depth,
      (sp.id is not null and not pollenia.can_view_as(p_viewer, sp.user_id, sp.visibility))
        or (fp.id is not null and not pollenia.can_view_as(p_viewer, fp.user_id, fp.visibility))
                                                                         as has_hidden_parent,
      array[pp.plant_id] as path
    from pollenia.plant_parents pp
    join pollenia.plants child   on child.id = pp.plant_id
    left join pollenia.plants sp on sp.id = pp.seed_parent_id
    left join pollenia.plants fp on fp.id = pp.pollen_parent_id
    where p_plant_id in (pp.seed_parent_id, pp.pollen_parent_id)
      and pollenia.can_view_as(p_viewer, child.user_id, child.visibility)

    union all

    select
      pp.plant_id,
      pp.crossing_id,
      case when pollenia.can_view_as(p_viewer, sp.user_id, sp.visibility)
           then pp.seed_parent_id end,
      case when pp.pollen_parent_id is not null
            and pollenia.can_view_as(p_viewer, fp.user_id, fp.visibility)
           then pp.pollen_parent_id end,
      l.depth + 1,
      (sp.id is not null and not pollenia.can_view_as(p_viewer, sp.user_id, sp.visibility))
        or (fp.id is not null and not pollenia.can_view_as(p_viewer, fp.user_id, fp.visibility)),
      l.path || pp.plant_id
    from pollenia.plant_parents pp
    join pollenia.plants child   on child.id = pp.plant_id
    left join pollenia.plants sp on sp.id = pp.seed_parent_id
    left join pollenia.plants fp on fp.id = pp.pollen_parent_id
    -- 子孫方向の辿りは plant_parents の生の親 ID を使う（表示用の NULL 化とは独立）
    join lineage l on l.plant_id in (pp.seed_parent_id, pp.pollen_parent_id)
    where l.depth < p_max_depth
      and not (pp.plant_id = any (l.path))
      and pollenia.can_view_as(p_viewer, child.user_id, child.visibility)
  )
  select plant_id, crossing_id, seed_parent_id, pollen_parent_id, depth, has_hidden_parent
  from lineage
$$;

-- ============================================================
-- 関数の実行権限
-- 新規関数は既定で PUBLIC に EXECUTE が付く。pollenia を PostgREST に露出した場合
-- anon が直接呼べてしまうため PUBLIC から剥奪し、Worker が使う service_role にだけ付与する。
-- can_view_as は definer 関数（get_*）の内部からのみ呼ばれるので誰にも grant しない。
-- ============================================================
revoke execute on function pollenia.can_view_as(uuid, uuid, pollenia.visibility)  from public;
revoke execute on function pollenia.get_ancestors(uuid, uuid, int)                from public;
revoke execute on function pollenia.get_descendants(uuid, uuid, int)              from public;
grant  execute on function pollenia.get_ancestors(uuid, uuid, int)                to service_role;
grant  execute on function pollenia.get_descendants(uuid, uuid, int)              to service_role;
