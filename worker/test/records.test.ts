import { describe, expect, it } from 'vitest';
import type { Sql } from '../src/lib/db';
import type { AuthedUser } from '../src/lib/auth';
import { handleDeleteCrossing } from '../src/routes/records';

// DELETE /api/crossings/:id の所有権判定を、実 DB を使わずフェイク sql で検証する
// （posts.test.ts と同じ流儀）。関連データ（採種・播種）のカスケード自体は
// FK の on delete cascade（0001_init.sql: seed_harvests.crossing_id / sowings.seed_harvest_id）
// で DB が保証するため、ハンドラは crossings への単発 delete のみを発行することを併せて確認する。

const VIEWER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CROSSING_MINE = '20000000-0000-4000-8000-000000000001';
const CROSSING_OTHER = '20000000-0000-4000-8000-000000000002';

const user: AuthedUser = { uid: VIEWER, displayName: 'わたし' };

// owner マップに基づき、delete ... where id=$1 and user_id=$2 が「マッチした行」を返す。
// マッチしなければ空配列（＝他人の記録／存在しない → RETURNING が 0 行）。
// 発行された SQL 文面を queries に記録して、対象テーブル・所有権述語を検証できるようにする。
function fakeSql(owner: Record<string, string>, queries: string[]): Sql {
  const handler = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const q = strings.join('$');
    queries.push(q);
    if (q.includes('delete from pollenia.crossings')) {
      const [crossingId, uid] = values as [string, string];
      return Promise.resolve(owner[crossingId] === uid ? [{ id: crossingId }] : []);
    }
    throw new Error(`fakeSql: 未対応のクエリ: ${q}`);
  };
  return handler as unknown as Sql;
}

describe('handleDeleteCrossing', () => {
  it('成功: 自分の交配記録は削除され 200 { ok, id } を返す', async () => {
    const queries: string[] = [];
    const sql = fakeSql({ [CROSSING_MINE]: VIEWER }, queries);
    const res = await handleDeleteCrossing(sql, user, CROSSING_MINE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: CROSSING_MINE });
    // crossings への単発 delete のみ（採種・播種は FK カスケード任せ）。
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('delete from pollenia.crossings');
    // 所有権述語が消えていないこと（回帰防止）。
    expect(queries[0]).toContain('user_id');
  });

  it('所有権違反: 他人の交配記録は RETURNING 0 行 → 404（存在を秘匿）', async () => {
    const queries: string[] = [];
    const sql = fakeSql({ [CROSSING_OTHER]: OTHER }, queries);
    const res = await handleDeleteCrossing(sql, user, CROSSING_OTHER);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'NOT_FOUND' });
    // where user_id で絞った delete は発行される（＝DB に問い合わせた上で 0 行）。
    expect(queries).toHaveLength(1);
  });

  it('不正な UUID は DB を叩かず 404', async () => {
    const queries: string[] = [];
    const sql = fakeSql({}, queries);
    const res = await handleDeleteCrossing(sql, user, 'not-a-uuid');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'NOT_FOUND' });
    expect(queries).toHaveLength(0);
  });
});
