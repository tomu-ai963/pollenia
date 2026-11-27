import { describe, expect, it } from 'vitest';
import type { Sql } from '../src/lib/db';
import type { AuthedUser } from '../src/lib/auth';
import { groupByParent, summarizeSowings, type SowingWithParents } from '../src/lib/germination';
import { handleGerminationByCrossing, handleGerminationByParent } from '../src/routes/analytics';

// 発芽率の集計（lib/germination.ts・routes/analytics.ts）。
// 交配ごとは無料、親ごとの比較は有料（402）。実 DB は使わずフェイク sql で検証する。

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const user: AuthedUser = { uid: ME, displayName: 'わたし' };
const ROSE_A = '10000000-0000-4000-8000-00000000000a';
const ROSE_B = '10000000-0000-4000-8000-00000000000b';
const ROSE_C = '10000000-0000-4000-8000-00000000000c';
const X1 = '20000000-0000-4000-8000-000000000001';
const X2 = '20000000-0000-4000-8000-000000000002';

const sow = (
  crossing_id: string,
  seed: string,
  pollen: string | null,
  sowing_count: number | null,
  germination_count: number | null,
  days_to_germination: number | null = null,
): SowingWithParents => ({
  crossing_id,
  seed_parent_id: seed,
  pollen_parent_id: pollen,
  sowing_count,
  germination_count,
  days_to_germination,
});

describe('summarizeSowings', () => {
  it('記録済みの播種だけで発芽率を出す（未記録は pending に数える）', () => {
    const s = summarizeSowings([
      sow(X1, ROSE_A, ROSE_B, 20, 15, 12),
      sow(X1, ROSE_A, ROSE_B, 10, 5, 18),
      sow(X1, ROSE_A, ROSE_B, 30, null), // まいたばかり
    ]);
    expect(s).toEqual({
      sowings: 3,
      pending_sowings: 1,
      sown: 30,
      germinated: 20,
      rate: 20 / 30,
      avg_days_to_germination: 15,
    });
  });

  it('記録済みの播種が無ければ rate は null（0% と区別する）', () => {
    expect(summarizeSowings([sow(X1, ROSE_A, null, 10, null)]).rate).toBeNull();
    expect(summarizeSowings([]).rate).toBeNull();
  });

  it('発芽 0 は 0%', () => {
    expect(summarizeSowings([sow(X1, ROSE_A, null, 10, 0)]).rate).toBe(0);
  });

  it('発芽数が播種数を超える入力は播種数で頭打ち', () => {
    const s = summarizeSowings([sow(X1, ROSE_A, null, 10, 12)]);
    expect(s.germinated).toBe(10);
    expect(s.rate).toBe(1);
  });

  it('播種数が無い・0 の播種は分母に入れない', () => {
    const s = summarizeSowings([sow(X1, ROSE_A, null, null, 3), sow(X1, ROSE_A, null, 0, 0)]);
    expect(s.sown).toBe(0);
    expect(s.rate).toBeNull();
    expect(s.pending_sowings).toBe(0);
  });

  it('発芽までの日数は 0 日以上だけを平均（小数1桁）', () => {
    const s = summarizeSowings([
      sow(X1, ROSE_A, null, 1, 1, 10),
      sow(X1, ROSE_A, null, 1, 1, 11),
      sow(X1, ROSE_A, null, 1, 1, 11),
      sow(X1, ROSE_A, null, 1, 1, -3), // 日付の入れ違い
    ]);
    expect(s.avg_days_to_germination).toBe(10.7);
  });
});

describe('groupByParent', () => {
  it('母木・花粉親を分けて数え、父不明は母木側だけ、自家受粉は両方に入る', () => {
    const parents = groupByParent([
      sow(X1, ROSE_A, ROSE_B, 10, 8),
      sow(X2, ROSE_A, null, 10, 2),
      sow('x3', ROSE_C, ROSE_C, 5, 5),
    ]);
    const a = parents.find((p) => p.plant_id === ROSE_A)!;
    expect(a.as_seed).toMatchObject({ sown: 20, germinated: 10, rate: 0.5 });
    expect(a.as_pollen).toBeNull();
    const b = parents.find((p) => p.plant_id === ROSE_B)!;
    expect(b.as_seed).toBeNull();
    expect(b.as_pollen).toMatchObject({ sown: 10, germinated: 8 });
    const c = parents.find((p) => p.plant_id === ROSE_C)!;
    expect(c.as_seed).toMatchObject({ sown: 5 });
    expect(c.as_pollen).toMatchObject({ sown: 5 });
    // 記録済みの播種数が多い親から
    expect(parents.map((p) => p.plant_id)).toEqual([ROSE_A, ROSE_C, ROSE_B]);
  });
});

// クエリの文面と値を記録しつつ、決めた行を返すフェイク sql。
function fakeSql(opts: { status?: string; sowings?: SowingWithParents[] }, queries: { q: string; values: unknown[] }[]): Sql {
  const handler = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const q = strings.join('$');
    queries.push({ q, values });
    if (q.includes('select subscription_status')) {
      return Promise.resolve([{ subscription_status: opts.status ?? 'free' }]);
    }
    if (q.includes('from pollenia.sowings s')) return Promise.resolve(opts.sowings ?? []);
    if (q.includes('from pollenia.crossings')) {
      return Promise.resolve([{ id: X1, cross_date: '2026-05-01' }]);
    }
    if (q.includes('from pollenia.plants')) {
      return Promise.resolve([
        { id: ROSE_A, name: 'ローズA' },
        { id: ROSE_B, name: 'ローズB' },
      ]);
    }
    throw new Error(`fakeSql: 未対応のクエリ: ${q}`);
  };
  return handler as unknown as Sql;
}

describe('GET /api/analytics/germination（無料）', () => {
  it('未加入でも交配ごとの集計が返る。すべてのクエリを自分の uid で絞る', async () => {
    const queries: { q: string; values: unknown[] }[] = [];
    const sql = fakeSql({ status: 'free', sowings: [sow(X1, ROSE_A, ROSE_B, 20, 10, 14)] }, queries);
    const res = await handleGerminationByCrossing(sql, user);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { overall: { rate: number }; crossings: Record<string, unknown>[] };
    expect(body.overall.rate).toBe(0.5);
    expect(body.crossings).toEqual([
      expect.objectContaining({
        crossing_id: X1,
        cross_date: '2026-05-01',
        seed_parent_name: 'ローズA',
        pollen_parent_name: 'ローズB',
        sown: 20,
        germinated: 10,
        avg_days_to_germination: 14,
      }),
    ]);
    expect(queries.some((x) => x.q.includes('subscription_status'))).toBe(false);
    for (const { q, values } of queries) {
      expect(q).toMatch(/user_id = \$::uuid/);
      expect(values).toContain(ME);
    }
    // 播種・採種・交配の3表すべてを uid で絞る
    const main = queries.find((x) => x.q.includes('from pollenia.sowings s'))!;
    expect(main.q.match(/user_id = \$::uuid/g)).toHaveLength(3);
  });

  it('播種が無ければ空', async () => {
    const res = await handleGerminationByCrossing(fakeSql({ sowings: [] }, []), user);
    expect(await res.json()).toEqual({
      overall: expect.objectContaining({ sowings: 0, rate: null }),
      crossings: [],
    });
  });
});

describe('GET /api/analytics/germination/parents（有料）', () => {
  it.each(['free', 'canceled'])('%s は 402。集計クエリを発行しない', async (status) => {
    const queries: { q: string; values: unknown[] }[] = [];
    const res = await handleGerminationByParent(fakeSql({ status }, queries), user);
    expect(res.status).toBe(402);
    expect(queries.some((x) => x.q.includes('pollenia.sowings'))).toBe(false);
  });

  it.each(['active', 'past_due'])('%s は親ごとの集計と名前が返る', async (status) => {
    const sql = fakeSql({ status, sowings: [sow(X1, ROSE_A, ROSE_B, 10, 4)] }, []);
    const res = await handleGerminationByParent(sql, user);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { parents: { plant_id: string; name: string }[] };
    expect(body.parents.map((p) => [p.plant_id, p.name])).toEqual([
      [ROSE_A, 'ローズA'],
      [ROSE_B, 'ローズB'],
    ]);
  });
});
