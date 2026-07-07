import type { Sql } from '../lib/db';
import { json } from '../lib/http';
import { errorResponse } from '../lib/error-response';
import type { AuthedUser } from '../lib/auth';
import { clampIntParam, isUuid } from '../lib/validate';
import { LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX } from '../constants';

// フォロー（follows）の API。フォローは**片方向**（設計判断1。相互判定はしない）。
// フォロー関係・フォロワー/フォロー中一覧は公開情報として扱う
// （profiles が公開前提のため。0002 の profiles_select 下書き参照）。

// POST /api/follows — フォローする。Request: { followee_id }
// 対象は pollenia.profiles 行を持つユーザーのみ（共有 Auth レルムの他プロダクト uid を
// 保存させない）。重複フォローは PK + on conflict do nothing で冪等（2回目は 200）。
export async function handleCreateFollow(
  req: Request,
  sql: Sql,
  user: AuthedUser,
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !isUuid(body.followee_id)) {
    return errorResponse('VALIDATION_ERROR', { publicMessage: 'followee_id は必須です。' });
  }
  const followeeId = body.followee_id;

  if (followeeId === user.uid) {
    // DB の check (follower_id <> followee_id) と同じ制約を入口で弾く
    return errorResponse('VALIDATION_ERROR', { publicMessage: '自分はフォローできません。' });
  }

  const target = await sql`
    select 1 from pollenia.profiles where id = ${followeeId}::uuid
  `;
  if (target.length === 0) return errorResponse('NOT_FOUND');

  const inserted = await sql`
    insert into pollenia.follows (follower_id, followee_id)
    values (${user.uid}::uuid, ${followeeId}::uuid)
    on conflict (follower_id, followee_id) do nothing
    returning followee_id
  `;
  return json({ ok: true, following: true }, inserted.length > 0 ? 201 : 200);
}

// DELETE /api/follows/:followee_id — フォロー解除。自分の行を消すだけなので冪等に 200。
export async function handleDeleteFollow(
  sql: Sql,
  user: AuthedUser,
  followeeId: string,
): Promise<Response> {
  if (!isUuid(followeeId)) return errorResponse('NOT_FOUND');
  await sql`
    delete from pollenia.follows
    where follower_id = ${user.uid}::uuid and followee_id = ${followeeId}::uuid
  `;
  return json({ ok: true, following: false });
}

// GET /api/users/:id/followers — :id をフォローしているユーザー一覧。
export async function handleListFollowers(
  req: Request,
  sql: Sql,
  targetId: string,
): Promise<Response> {
  return listFollowRelations(req, sql, targetId, 'followers');
}

// GET /api/users/:id/following — :id がフォローしているユーザー一覧。
export async function handleListFollowing(
  req: Request,
  sql: Sql,
  targetId: string,
): Promise<Response> {
  return listFollowRelations(req, sql, targetId, 'following');
}

async function listFollowRelations(
  req: Request,
  sql: Sql,
  targetId: string,
  direction: 'followers' | 'following',
): Promise<Response> {
  if (!isUuid(targetId)) return errorResponse('NOT_FOUND');
  const url = new URL(req.url);
  const limit = clampIntParam(url.searchParams.get('limit'), 1, LIST_LIMIT_MAX, LIST_LIMIT_DEFAULT);
  const offset = clampIntParam(url.searchParams.get('offset'), 0, 100_000, 0);

  const target = await sql`
    select 1 from pollenia.profiles where id = ${targetId}::uuid
  `;
  if (target.length === 0) return errorResponse('NOT_FOUND');

  // followers: followee_id = :id の follower 側 / following: follower_id = :id の followee 側
  const users =
    direction === 'followers'
      ? await sql`
          select p.id, p.display_name, p.avatar_path, f.created_at as followed_at
          from pollenia.follows f
          join pollenia.profiles p on p.id = f.follower_id
          where f.followee_id = ${targetId}::uuid
          order by f.created_at desc
          limit ${limit} offset ${offset}
        `
      : await sql`
          select p.id, p.display_name, p.avatar_path, f.created_at as followed_at
          from pollenia.follows f
          join pollenia.profiles p on p.id = f.followee_id
          where f.follower_id = ${targetId}::uuid
          order by f.created_at desc
          limit ${limit} offset ${offset}
        `;
  return json({ users });
}

// GET /api/users/:id — 公開プロフィール（プロフィールページのヘッダ用）。
// display_name / bio / avatar は公開前提（0002 の方針）。フォロー数と
// 「viewer がフォロー中か」を添える。
export async function handleGetUserProfile(
  sql: Sql,
  user: AuthedUser,
  targetId: string,
): Promise<Response> {
  if (!isUuid(targetId)) return errorResponse('NOT_FOUND');

  const rows = await sql`
    select id, display_name, bio, avatar_path, created_at from pollenia.profiles
    where id = ${targetId}::uuid
  `;
  if (rows.length === 0) return errorResponse('NOT_FOUND');

  const counts = await sql`
    select
      (select count(*)::int from pollenia.follows where followee_id = ${targetId}::uuid) as followers,
      (select count(*)::int from pollenia.follows where follower_id = ${targetId}::uuid) as following
  `;
  const viewerFollows = await sql`
    select 1 from pollenia.follows
    where follower_id = ${user.uid}::uuid and followee_id = ${targetId}::uuid
  `;

  return json({
    profile: {
      ...rows[0],
      follower_count: counts[0].followers,
      following_count: counts[0].following,
      followed_by_viewer: viewerFollows.length > 0,
    },
  });
}
