-- Phase 2: コミュニティ機能（posts / follows / likes / comments）
--
-- テーブル本体は 0001_init.sql で作成済み・RLS 有効化（deny-all）は 0002_rls.sql で
-- 適用済みのため、このマイグレーションは差分のみ:
--   1. フィード・プロフィール投稿一覧用の複合インデックス
--   2. deny-all RLS を Phase 2 でも維持する方針の明文化（下記コメント）
--
-- 設計判断（ハンドオフ確定事項）:
--   * フィード生成は Worker 側の2段階クエリ（follows → posts）で集約する。
--     RLS ポリシー内に「フォロー中ユーザーの post のみ」という動的サブクエリは埋め込まない。
--   * したがって 0002 の末尾に下書きされた読み取りポリシー（フロント直読み用）は
--     Phase 2 では有効化しない。RLS は「anon キー漏洩・PostgREST 直叩きでも漏れない」
--     ための最終防衛線として deny-all のまま維持する（pollenia スキーマは PostgREST 非露出継続）。
--   * likes / comments は独自 visibility を持たず、表示可否は常に親 post の可視性判定
--     （Worker 側 lib/visibility.ts）に委譲する。
--   * F6: 公開 post が非公開 crossing を crossing_id で参照しうる（posts の既定 public /
--     plants の既定 private の非対称）。crossing の展開可否は post の可視性を継承せず、
--     Worker が crossing 自身の所有者判定（canViewOwnerOnly）で別途決める。

-- フィード: 「user_id in (フォロー中) order by created_at desc」を1インデックスで賄う。
-- プロフィール投稿一覧（単一 user_id + created_at desc）も同じインデックスで済む。
create index idx_posts_user_created on pollenia.posts (user_id, created_at desc);

-- 先頭カラムが重複する単柱インデックスは冗長になるため削除。
drop index if exists pollenia.idx_posts_user;

-- likes の「viewer が付けたいいねの取り消し・重複判定」は PK (user_id, post_id) が担い、
-- 「post ごとの件数・viewer の liked 判定」は 0001 の idx_likes_post が担う。追加不要。
-- comments の一覧は 0001 の idx_comments_post + created_at ソート（少件数前提）で開始し、
-- 伸びたら (post_id, created_at) 複合化を検討する。
