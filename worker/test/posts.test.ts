import { describe, expect, it } from 'vitest';
import type { Sql } from '../src/lib/db';
import { serializePosts } from '../src/routes/posts';

// F6 の検証（このアプリのセキュリティ上の最重要ルール）:
// posts.visibility の既定は public / plants の既定は private という非対称があるため、
// 「post が見える → 紐付く crossing も見せる」と実装すると非公開の交配・親個体が漏れる。
// serializePosts は post の可視性を継承せず、crossing 自身の所有者判定
// （canViewOwnerOnly）を通った場合のみ展開しなければならない。

const VIEWER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const POST_MINE = '10000000-0000-4000-8000-000000000001';
const POST_OTHER = '10000000-0000-4000-8000-000000000002';
const CROSSING_MINE = '20000000-0000-4000-8000-000000000001';
const CROSSING_OTHER = '20000000-0000-4000-8000-000000000002';
const SEED = '30000000-0000-4000-8000-000000000001';
const POLLEN = '30000000-0000-4000-8000-000000000002';

// serializePosts が発行するクエリをテーブル名で振り分けるフェイク sql。
// 重要: crossings は「両ユーザーの行」を返す（DB 側では絞らない想定で、
// フィルタが Worker の canViewOwnerOnly のみで行われても漏れないことを検証する）。
function fakeSql(): Sql {
  const handler = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const q = strings.join('$');
    if (q.includes('from pollenia.profiles')) {
      return Promise.resolve([
        { id: VIEWER, display_name: 'わたし', avatar_path: null },
        { id: OTHER, display_name: 'ほかのひと', avatar_path: 'x.jpg' },
      ]);
    }
    if (q.includes('from pollenia.likes') && q.includes('group by')) {
      return Promise.resolve([{ post_id: POST_OTHER, n: 3 }]);
    }
    if (q.includes('from pollenia.comments') && q.includes('group by')) {
      return Promise.resolve([{ post_id: POST_MINE, n: 1 }]);
    }
    if (q.includes('from pollenia.likes')) {
      return Promise.resolve([{ post_id: POST_OTHER }]); // viewer は他人の post に like 済み
    }
    if (q.includes('from pollenia.crossings')) {
      return Promise.resolve([
        {
          id: CROSSING_MINE,
          user_id: VIEWER,
          seed_parent_id: SEED,
          pollen_parent_id: POLLEN,
          cross_date: '2026-01-01',
          notes: '自分の交配メモ',
        },
        {
          id: CROSSING_OTHER,
          user_id: OTHER,
          seed_parent_id: SEED,
          pollen_parent_id: null,
          cross_date: '2026-02-01',
          notes: '他人の非公開メモ',
        },
      ]);
    }
    if (q.includes('from pollenia.plants')) {
      return Promise.resolve([
        { id: SEED, name: '母木A' },
        { id: POLLEN, name: '父木B' },
      ]);
    }
    throw new Error(`fakeSql: 未対応のクエリ: ${q}`);
  };
  return handler as unknown as Sql;
}

function post(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: POST_MINE,
    user_id: VIEWER,
    crossing_id: null,
    content: 'hello',
    visibility: 'public',
    created_at: 't1',
    updated_at: 't1',
    ...overrides,
  };
}

describe('serializePosts (F6)', () => {
  it('自分の crossing は展開される（親個体名付き）', async () => {
    const [p] = await serializePosts(fakeSql(), VIEWER, [
      post({ crossing_id: CROSSING_MINE }),
    ]);
    expect(p.crossing).toMatchObject({
      id: CROSSING_MINE,
      seed_parent_name: '母木A',
      pollen_parent_name: '父木B',
      notes: '自分の交配メモ',
    });
  });

  it('公開 post 経由でも他人の crossing は展開されない（crossing_id ごと伏せる）', async () => {
    const [p] = await serializePosts(fakeSql(), VIEWER, [
      post({ id: POST_OTHER, user_id: OTHER, crossing_id: CROSSING_OTHER }),
    ]);
    // post 本文は返る（post 自体は隠さない）
    expect(p.content).toBe('hello');
    expect(p.author_display_name).toBe('ほかのひと');
    // crossing 情報は一切返らない（notes・親 ID・crossing_id 含む）
    expect(p.crossing).toBeNull();
    expect(p).not.toHaveProperty('crossing_id');
    expect(JSON.stringify(p)).not.toContain(CROSSING_OTHER);
    expect(JSON.stringify(p)).not.toContain('非公開メモ');
  });

  it('crossing_id なしの post は crossing: null', async () => {
    const [p] = await serializePosts(fakeSql(), VIEWER, [post({})]);
    expect(p.crossing).toBeNull();
  });

  it('like/comment 数と liked_by_viewer が post ごとに対応付く', async () => {
    const [mine, other] = await serializePosts(fakeSql(), VIEWER, [
      post({}),
      post({ id: POST_OTHER, user_id: OTHER }),
    ]);
    expect(mine.like_count).toBe(0);
    expect(mine.comment_count).toBe(1);
    expect(mine.liked_by_viewer).toBe(false);
    expect(other.like_count).toBe(3);
    expect(other.comment_count).toBe(0);
    expect(other.liked_by_viewer).toBe(true);
  });

  it('空配列は DB を叩かず空を返す', async () => {
    const sql = (() => {
      throw new Error('should not be called');
    }) as unknown as Sql;
    expect(await serializePosts(sql, VIEWER, [])).toEqual([]);
  });
});
