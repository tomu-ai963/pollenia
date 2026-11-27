import { describe, expect, it } from 'vitest';
import type { Sql } from '../src/lib/db';
import type { AuthedUser } from '../src/lib/auth';
import { buildTasks, type TaskSource } from '../src/lib/tasks';
import { handleListTasks, handleUpdateTask } from '../src/routes/tasks';

// 「次の作業」（lib/tasks.ts・routes/tasks.ts）。実 DB は使わずフェイク sql で検証する。

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const user: AuthedUser = { uid: ME, displayName: 'わたし' };
const A = '10000000-0000-4000-8000-00000000000a';
const B = '10000000-0000-4000-8000-00000000000b';
const REC = '30000000-0000-4000-8000-000000000001';

let n = 0;
const src = (o: Partial<TaskSource>): TaskSource => ({
  kind: 'harvest',
  record_id: `r${++n}`,
  crossing_id: 'x',
  seed_parent_id: A,
  pollen_parent_id: B,
  since_date: null,
  planned_date: null,
  sow_by_date: null,
  count: null,
  first_germination_date: null,
  ...o,
});

describe('buildTasks', () => {
  it('期日 = 予定日と種の使用期限のうち早いほう', () => {
    const [t] = buildTasks([src({ kind: 'sow', planned_date: '2027-03-01', sow_by_date: '2027-02-01' })], new Map());
    expect(t.due_date).toBe('2027-02-01');
    const [u] = buildTasks([src({ kind: 'sow', sow_by_date: '2027-02-01' })], new Map());
    expect(u.due_date).toBe('2027-02-01');
    const [v] = buildTasks([src({})], new Map());
    expect(v.due_date).toBeNull();
  });

  it('期日のあるものが先（早い順）、期日なしは起点の日が古い順、起点もなしは最後', () => {
    const tasks = buildTasks(
      [
        src({ record_id: 'none' }),
        src({ record_id: 'since-new', since_date: '2026-10-01' }),
        src({ record_id: 'due-late', planned_date: '2027-01-10' }),
        src({ record_id: 'since-old', since_date: '2026-05-01' }),
        src({ record_id: 'due-early', planned_date: '2026-12-01' }),
      ],
      new Map(),
    );
    expect(tasks.map((t) => t.record_id)).toEqual(['due-early', 'due-late', 'since-old', 'since-new', 'none']);
  });

  it('親の名前を付ける（父不明は null）', () => {
    const names = new Map([
      [A, 'ローズA'],
      [B, 'ローズB'],
    ]);
    const [t, u] = buildTasks([src({}), src({ pollen_parent_id: null, since_date: '2026-01-01' })], names);
    expect([t.seed_parent_name, t.pollen_parent_name]).toEqual(['ローズA', null]);
    expect([u.seed_parent_name, u.pollen_parent_name]).toEqual(['ローズA', 'ローズB']);
  });
});

type Q = { q: string; values: unknown[] };
function fakeSql(queries: Q[], opts: { updateMatches?: boolean } = {}): Sql {
  const tag = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const q = strings.join('$');
    queries.push({ q, values });
    if (q.includes("'harvest' as kind")) {
      return Promise.resolve([src({ kind: 'harvest', record_id: 'c1', since_date: '2026-05-01' })]);
    }
    if (q.includes("'sow' as kind")) {
      return Promise.resolve([src({ kind: 'sow', record_id: 'h1', sow_by_date: '2027-04-01', count: 50 })]);
    }
    if (q.includes("'germination' as kind")) return Promise.resolve([]);
    if (q.includes('from pollenia.plants')) return Promise.resolve([{ id: A, name: 'ローズA' }]);
    if (q.includes('update pollenia.')) {
      return Promise.resolve(opts.updateMatches === false ? [] : [{ id: REC }]);
    }
    throw new Error(`fakeSql: 未対応のクエリ: ${q}`);
  };
  // sql(patch) … update の set 句。中身を記録できるよう、そのまま返す
  const fn = (first: unknown, ...rest: unknown[]) =>
    Array.isArray(first) && 'raw' in (first as object)
      ? tag(first as unknown as TemplateStringsArray, ...rest)
      : { __patch: first };
  return fn as unknown as Sql;
}

describe('GET /api/tasks', () => {
  it('3種類の作業をまとめて期日順に返す。すべてのクエリを自分の uid で絞る', async () => {
    const queries: Q[] = [];
    const res = await handleListTasks(fakeSql(queries), user);
    expect(res.status).toBe(200);
    const { tasks } = (await res.json()) as { tasks: { kind: string; record_id: string; due_date: string | null }[] };
    expect(tasks.map((t) => [t.kind, t.record_id, t.due_date])).toEqual([
      ['sow', 'h1', '2027-04-01'],
      ['harvest', 'c1', null],
    ]);
    for (const { q, values } of queries) {
      expect(q).toMatch(/user_id = \$::uuid/);
      expect(values).toContain(ME);
    }
    // 外した作業は出さない・次の記録の有無も自分の記録だけで判定する
    const harvestQ = queries.find((x) => x.q.includes("'harvest' as kind"))!.q;
    expect(harvestQ).toContain('task_dismissed_at is null');
    expect(harvestQ.match(/user_id = \$::uuid/g)).toHaveLength(2);
    const germQ = queries.find((x) => x.q.includes("'germination' as kind"))!.q;
    expect(germQ).toContain('germination_count is null');
    expect(germQ.match(/user_id = \$::uuid/g)).toHaveLength(3);
  });
});

const patchReq = (body: unknown) =>
  new Request('http://x/api/tasks', { method: 'PATCH', body: JSON.stringify(body) });

describe('PATCH /api/tasks/:kind/:id', () => {
  it.each([
    ['harvest', 'crossings', 'expected_harvest_date'],
    ['sow', 'seed_harvests', 'planned_sowing_date'],
    ['germination', 'sowings', 'expected_germination_date'],
  ])('%s の予定日は %s.%s に入る（自分の記録だけ）', async (kind, table, column) => {
    const queries: Q[] = [];
    const res = await handleUpdateTask(patchReq({ due_date: '2027-01-15' }), fakeSql(queries), user, kind, REC);
    expect(res.status).toBe(200);
    const upd = queries.find((x) => x.q.includes('update'))!;
    expect(upd.q).toContain(`update pollenia.${table} set`);
    expect(upd.q).toMatch(/where id = \$::uuid and user_id = \$::uuid/);
    expect(upd.values).toEqual([{ __patch: { [column]: '2027-01-15' } }, REC, ME]);
  });

  it('外す / 戻す・予定日を消す', async () => {
    const queries: Q[] = [];
    await handleUpdateTask(patchReq({ dismissed: true, due_date: null }), fakeSql(queries), user, 'harvest', REC);
    const patch = (queries.at(-1)!.values[0] as { __patch: Record<string, unknown> }).__patch;
    expect(patch.expected_harvest_date).toBeNull();
    expect(patch.task_dismissed_at).toBeInstanceOf(Date);
    await handleUpdateTask(patchReq({ dismissed: false }), fakeSql(queries), user, 'harvest', REC);
    expect((queries.at(-1)!.values[0] as { __patch: unknown }).__patch).toEqual({ task_dismissed_at: null });
  });

  it('種の使用期限は播種の作業だけ', async () => {
    const ok = await handleUpdateTask(patchReq({ sow_by_date: '2027-04-01' }), fakeSql([]), user, 'sow', REC);
    expect(ok.status).toBe(200);
    const ng = await handleUpdateTask(patchReq({ sow_by_date: '2027-04-01' }), fakeSql([]), user, 'harvest', REC);
    expect(ng.status).toBe(400);
  });

  it.each([
    [{ due_date: '2027-02-30' }],
    [{ due_date: '2027/01/01' }],
    [{ dismissed: 'yes' }],
    [{}],
  ])('不正な入力は 400: %j', async (body) => {
    const res = await handleUpdateTask(patchReq(body), fakeSql([]), user, 'harvest', REC);
    expect(res.status).toBe(400);
  });

  it('知らない種類・ID の形でない・他人の記録は 404（更新しない）', async () => {
    const queries: Q[] = [];
    expect((await handleUpdateTask(patchReq({ dismissed: true }), fakeSql(queries), user, 'plants', REC)).status).toBe(404);
    expect((await handleUpdateTask(patchReq({ dismissed: true }), fakeSql(queries), user, 'harvest', 'x')).status).toBe(404);
    expect(queries).toHaveLength(0);
    const res = await handleUpdateTask(patchReq({ dismissed: true }), fakeSql([], { updateMatches: false }), user, 'sow', REC);
    expect(res.status).toBe(404);
  });
});
