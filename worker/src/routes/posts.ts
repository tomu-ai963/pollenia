import { uuidArrayLiteral, type Sql } from '../lib/db';
import { json } from '../lib/http';
import { errorResponse } from '../lib/error-response';
import type { AuthedUser } from '../lib/auth';
import { canViewOwnerOnly, canViewWithDb, type Visibility } from '../lib/visibility';
import { asText, asVisibility, clampIntParam, isUuid } from '../lib/validate';
import {
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  MAX_COMMENT_LEN,
  MAX_POST_LEN,
} from '../constants';

// 投稿（posts）・いいね（likes）・コメント（comments）の API。
//
// 可視性の原則:
//   - post 本体 … posts.visibility + 所有者で判定（lib/visibility.ts の canView 系）。
//     不可視は 404（存在を秘匿。403 と使い分けない）。
//   - likes / comments … 独自 visibility を持たず、常に親 post の可視性に完全追従。
//   - crossing 展開（F6・最重要）… post が閲覧可でも継承しない。crossings は
//     visibility 列を持たない＝所有者のみのデータなので、展開可否は必ず
//     canViewOwnerOnly(viewer, crossing.user_id) で別途判定し、不可視なら
//     crossing 情報（crossing_id 含む）を伏せて post 本文のみ返す。
//     posts.visibility の既定 public / plants の既定 private の非対称があるため、
//     ここを post の可視性で代用すると非公開の交配・親個体が公開 post 経由で漏れる。

const POST_COLS = 'id, user_id, crossing_id, content, visibility, created_at, updated_at';

// POST /api/posts — 投稿作成。
// Request: { content(必須), crossing_id?, visibility? }
// crossing_id は**自分の交配記録**のみ紐付け可（他人の crossing ID を保存させない）。
export async function handleCreatePost(
  req: Request,
  sql: Sql,
  user: AuthedUser,
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return errorResponse('VALIDATION_ERROR', { publicMessage: 'JSON ボディが必要です。' });

  const content = asText(body.content, MAX_POST_LEN);
  if (!content) {
    return errorResponse('VALIDATION_ERROR', {
      publicMessage: `content は必須です（${MAX_POST_LEN}文字以内）。`,
    });
  }

  let visibility: Visibility = 'public'; // DB 既定と同じ（0001 参照）
  if (body.visibility !== undefined) {
    const v = asVisibility(body.visibility);
    if (!v) {
      return errorResponse('VALIDATION_ERROR', {
        publicMessage: 'visibility は public | followers | private。',
      });
    }
    visibility = v;
  }

  let crossingId: string | null = null;
  if (body.crossing_id !== undefined && body.crossing_id !== null) {
    if (!isUuid(body.crossing_id)) {
      return errorResponse('VALIDATION_ERROR', { publicMessage: 'crossing_id が不正です。' });
    }
    const own = await sql`
      select 1 from pollenia.crossings
      where id = ${body.crossing_id}::uuid and user_id = ${user.uid}::uuid
    `;
    if (own.length === 0) {
      return errorResponse('VALIDATION_ERROR', {
        publicMessage: 'crossing_id が自分の交配記録ではありません。',
      });
    }
    crossingId = body.crossing_id;
  }

  const rows = await sql`
    insert into pollenia.posts (user_id, crossing_id, content, visibility)
    values (${user.uid}::uuid, ${crossingId ? sql`${crossingId}::uuid` : null},
            ${content}, ${visibility})
    returning ${sql.unsafe(POST_COLS)}
  `;
  const [serialized] = await serializePosts(sql, user.uid, rows);
  return json({ post: serialized }, 201);
}

// GET /api/posts/:id — 投稿単体。post 本体の可視性判定 + F6 の crossing 展開。
export async function handleGetPost(
  sql: Sql,
  user: AuthedUser,
  postId: string,
): Promise<Response> {
  if (!isUuid(postId)) return errorResponse('NOT_FOUND');

  const rows = await sql`
    select ${sql.unsafe(POST_COLS)} from pollenia.posts where id = ${postId}::uuid
  `;
  if (rows.length === 0) return errorResponse('NOT_FOUND');
  const post = rows[0];

  const visible = await canViewWithDb(sql, user.uid, {
    ownerId: post.user_id,
    visibility: post.visibility as Visibility,
  });
  if (!visible) return errorResponse('NOT_FOUND');

  const [serialized] = await serializePosts(sql, user.uid, [post]);
  return json({ post: serialized });
}

// GET /api/feed — フィード。Worker 側の2段階クエリで集約する（設計判断3）:
//   (a) follows からフォロー中の user_id 一覧を取得
//   (b) その user_id の posts を visibility 条件（public | followers）で絞る
// RLS に動的サブクエリは埋め込まない。viewer はフォロワーなので followers 可視で正しい。
// private は所有者のみ＝フィードには決して載らない。
export async function handleFeed(req: Request, sql: Sql, user: AuthedUser): Promise<Response> {
  const url = new URL(req.url);
  const limit = clampIntParam(url.searchParams.get('limit'), 1, LIST_LIMIT_MAX, LIST_LIMIT_DEFAULT);
  const offset = clampIntParam(url.searchParams.get('offset'), 0, 100_000, 0);

  const followees = await sql`
    select followee_id from pollenia.follows where follower_id = ${user.uid}::uuid
  `;
  if (followees.length === 0) return json({ posts: [] });

  const posts = await sql`
    select ${sql.unsafe(POST_COLS)}
    from pollenia.posts
    where user_id = any(${uuidArrayLiteral(followees.map((f) => f.followee_id))}::uuid[])
      and visibility in ('public', 'followers')
    order by created_at desc
    limit ${limit} offset ${offset}
  `;
  return json({ posts: await serializePosts(sql, user.uid, posts) });
}

// GET /api/users/:id/posts — プロフィールページ用。対象ユーザーの投稿のうち
// viewer に可視なものだけ（本人=全件 / フォロワー=public+followers / 他人=public のみ）。
export async function handleListUserPosts(
  req: Request,
  sql: Sql,
  user: AuthedUser,
  targetId: string,
): Promise<Response> {
  if (!isUuid(targetId)) return errorResponse('NOT_FOUND');
  const url = new URL(req.url);
  const limit = clampIntParam(url.searchParams.get('limit'), 1, LIST_LIMIT_MAX, LIST_LIMIT_DEFAULT);
  const offset = clampIntParam(url.searchParams.get('offset'), 0, 100_000, 0);

  const target = await sql`
    select id from pollenia.profiles where id = ${targetId}::uuid
  `;
  if (target.length === 0) return errorResponse('NOT_FOUND');

  // 可視 visibility の集合を先に確定してから1クエリで絞る。
  // 判定意味論は lib/visibility.ts の canView と一致させること。
  let visibilityCond;
  if (targetId === user.uid) {
    visibilityCond = sql`true`;
  } else {
    const follows = await sql`
      select 1 from pollenia.follows
      where follower_id = ${user.uid}::uuid and followee_id = ${targetId}::uuid
    `;
    visibilityCond =
      follows.length > 0
        ? sql`visibility in ('public', 'followers')`
        : sql`visibility = 'public'`;
  }

  const posts = await sql`
    select ${sql.unsafe(POST_COLS)}
    from pollenia.posts
    where user_id = ${targetId}::uuid and ${visibilityCond}
    order by created_at desc
    limit ${limit} offset ${offset}
  `;
  return json({ posts: await serializePosts(sql, user.uid, posts) });
}

// POST /api/posts/:id/likes — いいね。親 post が見えるときのみ（likes は post に完全追従）。
// 重複いいねは PK (user_id, post_id) + on conflict do nothing で冪等（2回目は 200）。
export async function handleCreateLike(
  sql: Sql,
  user: AuthedUser,
  postId: string,
): Promise<Response> {
  const post = await loadVisiblePost(sql, user, postId);
  if (!post.ok) return post.response;

  const inserted = await sql`
    insert into pollenia.likes (user_id, post_id)
    values (${user.uid}::uuid, ${postId}::uuid)
    on conflict (user_id, post_id) do nothing
    returning post_id
  `;
  const count = await likeCount(sql, postId);
  return json({ ok: true, liked: true, like_count: count }, inserted.length > 0 ? 201 : 200);
}

// DELETE /api/posts/:id/likes — いいね解除。自分の like 行を消すだけなので冪等に 200。
// 注意: 親 post の可視性チェックは行わない（post が private 化された後でも自分の like は
// 取り消せるべき）。ただし post の情報（like_count 含む）は一切返さない。
export async function handleDeleteLike(
  sql: Sql,
  user: AuthedUser,
  postId: string,
): Promise<Response> {
  if (!isUuid(postId)) return errorResponse('NOT_FOUND');
  await sql`
    delete from pollenia.likes
    where user_id = ${user.uid}::uuid and post_id = ${postId}::uuid
  `;
  return json({ ok: true, liked: false });
}

// POST /api/posts/:id/comments — コメント投稿。親 post が見えるときのみ。
export async function handleCreateComment(
  req: Request,
  sql: Sql,
  user: AuthedUser,
  postId: string,
): Promise<Response> {
  const post = await loadVisiblePost(sql, user, postId);
  if (!post.ok) return post.response;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const content = asText(body?.content, MAX_COMMENT_LEN);
  if (!content) {
    return errorResponse('VALIDATION_ERROR', {
      publicMessage: `content は必須です（${MAX_COMMENT_LEN}文字以内）。`,
    });
  }

  const rows = await sql`
    insert into pollenia.comments (post_id, user_id, content)
    values (${postId}::uuid, ${user.uid}::uuid, ${content})
    returning id, post_id, user_id, content, created_at
  `;
  return json({ comment: { ...rows[0], author_display_name: user.displayName } }, 201);
}

// GET /api/posts/:id/comments — コメント一覧（古い順）。親 post が見えるときのみ。
export async function handleListComments(
  req: Request,
  sql: Sql,
  user: AuthedUser,
  postId: string,
): Promise<Response> {
  const post = await loadVisiblePost(sql, user, postId);
  if (!post.ok) return post.response;

  const url = new URL(req.url);
  const limit = clampIntParam(url.searchParams.get('limit'), 1, LIST_LIMIT_MAX, LIST_LIMIT_DEFAULT);
  const offset = clampIntParam(url.searchParams.get('offset'), 0, 100_000, 0);

  const comments = await sql`
    select c.id, c.post_id, c.user_id, c.content, c.created_at,
           p.display_name as author_display_name
    from pollenia.comments c
    join pollenia.profiles p on p.id = c.user_id
    where c.post_id = ${postId}::uuid
    order by c.created_at asc
    limit ${limit} offset ${offset}
  `;
  return json({ comments });
}

// ---------------------------------------------------------------------------
// 内部ヘルパー
// ---------------------------------------------------------------------------

type LoadResult = { ok: true } | { ok: false; response: Response };

// likes / comments 共通の「親 post が viewer に見えるか」ゲート。不可視は 404。
async function loadVisiblePost(sql: Sql, user: AuthedUser, postId: string): Promise<LoadResult> {
  if (!isUuid(postId)) return { ok: false, response: errorResponse('NOT_FOUND') };
  const rows = await sql`
    select user_id, visibility from pollenia.posts where id = ${postId}::uuid
  `;
  if (rows.length === 0) return { ok: false, response: errorResponse('NOT_FOUND') };
  const visible = await canViewWithDb(sql, user.uid, {
    ownerId: rows[0].user_id,
    visibility: rows[0].visibility as Visibility,
  });
  if (!visible) return { ok: false, response: errorResponse('NOT_FOUND') };
  return { ok: true };
}

async function likeCount(sql: Sql, postId: string): Promise<number> {
  const rows = await sql`
    select count(*)::int as n from pollenia.likes where post_id = ${postId}::uuid
  `;
  return rows[0].n as number;
}

// post 一覧/単体の共通シリアライズ。author・like/comment 数・viewer の liked に加え、
// F6 ルールで crossing を展開する。
//
// F6（このアプリのセキュリティ上の最重要ルール）:
//   crossing の展開可否は post の可視性を**継承しない**。crossings は visibility 列を
//   持たない＝所有者のみ可視（lib/visibility.ts のテーブル対応表）なので、
//   canViewOwnerOnly(viewer, crossing.user_id) を通った場合のみ展開する。
//   通らない場合は crossing 情報を伏せて post 本文のみ返す（post 自体は隠さない）。
//   レスポンスには生の crossing_id も含めない（内部 ID の不要な露出を避ける）。
//   親個体名の join も「viewer 所有の plants」に限定した二重ガードにする。
export async function serializePosts(
  sql: Sql,
  viewerId: string,
  posts: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (posts.length === 0) return [];

  const postIds = posts.map((p) => p.id as string);
  const userIds = [...new Set(posts.map((p) => p.user_id as string))];

  const authors = await sql`
    select id, display_name, avatar_path from pollenia.profiles
    where id = any(${uuidArrayLiteral(userIds)}::uuid[])
  `;
  const authorById = new Map(authors.map((a) => [a.id, a]));

  const likeCounts = await sql`
    select post_id, count(*)::int as n from pollenia.likes
    where post_id = any(${uuidArrayLiteral(postIds)}::uuid[])
    group by post_id
  `;
  const likesByPost = new Map(likeCounts.map((r) => [r.post_id, r.n]));

  const commentCounts = await sql`
    select post_id, count(*)::int as n from pollenia.comments
    where post_id = any(${uuidArrayLiteral(postIds)}::uuid[])
    group by post_id
  `;
  const commentsByPost = new Map(commentCounts.map((r) => [r.post_id, r.n]));

  const viewerLikes = await sql`
    select post_id from pollenia.likes
    where user_id = ${viewerId}::uuid
      and post_id = any(${uuidArrayLiteral(postIds)}::uuid[])
  `;
  const likedSet = new Set(viewerLikes.map((r) => r.post_id));

  // F6: crossing 展開。候補を集めて一括で引き、行ごとに canViewOwnerOnly で判定する。
  const crossingIds = [
    ...new Set(posts.map((p) => p.crossing_id as string | null).filter(Boolean)),
  ] as string[];
  const expandedByCrossingId = new Map<string, unknown>();
  if (crossingIds.length > 0) {
    const crossings = await sql`
      select id, user_id, seed_parent_id, pollen_parent_id, cross_date, notes
      from pollenia.crossings
      where id = any(${uuidArrayLiteral(crossingIds)}::uuid[])
    `;
    const visibleCrossings = crossings.filter((c) =>
      canViewOwnerOnly(viewerId, c.user_id as string),
    );
    if (visibleCrossings.length > 0) {
      const parentIds = [
        ...new Set(
          visibleCrossings
            .flatMap((c) => [c.seed_parent_id, c.pollen_parent_id])
            .filter(Boolean),
        ),
      ] as string[];
      // 展開は所有者のみに許しているため、親個体名の join も viewer 所有分に限定する
      const parents = parentIds.length
        ? await sql`
            select id, name from pollenia.plants
            where id = any(${uuidArrayLiteral(parentIds)}::uuid[])
              and user_id = ${viewerId}::uuid
          `
        : [];
      const nameById = new Map(parents.map((p) => [p.id, p.name]));
      for (const c of visibleCrossings) {
        expandedByCrossingId.set(c.id as string, {
          id: c.id,
          seed_parent_id: c.seed_parent_id,
          pollen_parent_id: c.pollen_parent_id,
          seed_parent_name: nameById.get(c.seed_parent_id) ?? null,
          pollen_parent_name: c.pollen_parent_id
            ? nameById.get(c.pollen_parent_id) ?? null
            : null,
          cross_date: c.cross_date,
          notes: c.notes,
        });
      }
    }
  }

  return posts.map((p) => {
    const author = authorById.get(p.user_id);
    return {
      id: p.id,
      user_id: p.user_id,
      author_display_name: author?.display_name ?? null,
      author_avatar_path: author?.avatar_path ?? null,
      content: p.content,
      visibility: p.visibility,
      created_at: p.created_at,
      updated_at: p.updated_at,
      like_count: likesByPost.get(p.id) ?? 0,
      comment_count: commentsByPost.get(p.id) ?? 0,
      liked_by_viewer: likedSet.has(p.id),
      // F6: 不可視の crossing は crossing_id ごと伏せる（null と区別できない形にする）
      crossing: p.crossing_id
        ? expandedByCrossingId.get(p.crossing_id as string) ?? null
        : null,
    };
  });
}
