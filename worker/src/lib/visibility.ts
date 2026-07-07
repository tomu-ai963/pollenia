import type { Sql } from './db';

// 可視性判定の共通モジュール（セキュリティレビュー F6 対応の先取り）。
//
// 原則: 「閲覧できるか」は常に **対象データ自身の visibility 列 + 所有者** で判定する。
// 参照元エンティティの公開状態を継承してはならない。
//   - Phase 2 の具体例: posts.visibility の既定は public、plants の既定は private と
//     非対称なため、「post が見える → 紐付く crossing も見せる」と実装すると
//     非公開の交配・親個体が公開 post 経由で漏れる。crossing の展開時は必ず
//     canViewOwnerOnly(viewer, crossing.user_id) / 親 plants の canView を別途通すこと。
//   - SQL 側の同じ意味論は pollenia.can_view_as()（系統樹 RPC が使用）。
//     このモジュールは Worker 側でエンティティ単体を判定するときの唯一の入口にする。
//
// テーブルごとの対応:
//   - plants / posts        … visibility 列を持つ → canView / canViewWithDb
//   - crossings / seed_harvests / sowings … 可視性を持たない＝所有者のみ → canViewOwnerOnly
//     （他人への系統公開は get_ancestors/get_descendants RPC 経由に限定。datamodel.md 参照）
//   - plant_photos          … 親 plant の可視性に従う（写真は plant の属性であり
//     「参照元の継承」ではない）。呼び出し側は親 plant の行を引いてから canView を通すこと。

export type Visibility = 'public' | 'followers' | 'private';

export interface VisibilityTarget {
  ownerId: string;
  visibility: Visibility;
}

// 純粋関数。viewerId = null は匿名（公開ページ）。
// isFollower は「viewer が owner をフォローしているか」を呼び出し側で解決して渡す。
export function canView(
  viewerId: string | null,
  target: VisibilityTarget,
  isFollower = false,
): boolean {
  if (target.visibility === 'public') return true;
  if (viewerId === null) return false;
  if (viewerId === target.ownerId) return true;
  return target.visibility === 'followers' && isFollower;
}

// visibility 列を持たないテーブル（crossings / seed_harvests / sowings）用: 所有者のみ可視。
export function canViewOwnerOnly(viewerId: string | null, ownerId: string): boolean {
  return viewerId !== null && viewerId === ownerId;
}

// DB 付き版。followers 判定が必要なときだけ follows を引く。
// SQL の pollenia.can_view_as(p_viewer, p_owner, p_visibility) と同じ意味論を保つこと。
export async function canViewWithDb(
  sql: Sql,
  viewerId: string | null,
  target: VisibilityTarget,
): Promise<boolean> {
  if (canView(viewerId, target)) return true;
  if (target.visibility !== 'followers' || viewerId === null) return false;
  const rows = await sql`
    select 1 from pollenia.follows
    where followee_id = ${target.ownerId}::uuid
      and follower_id = ${viewerId}::uuid
  `;
  return rows.length > 0;
}
