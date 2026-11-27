import { describe, expect, it } from 'vitest';
import type { Sql } from '../src/lib/db';
import type { AuthedUser } from '../src/lib/auth';
import { summarizeOffspring } from '../src/lib/segregation';
import { handleSegregation } from '../src/routes/analytics';
import { handleCreateSeedStock, handleDeleteSeedStock, handleUpdateSeedStock } from '../src/routes/seed-stocks';
import { handleCreateExchange, handleListExchange, handleUpdateExchange } from '../src/routes/exchange';
import { serializePosts } from '../src/routes/posts';

// 形質の分離（④）・種と花粉の在庫と交換（⑥）。実 DB は使わずフェイク sql で検証する。

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STOCK = '40000000-0000-4000-8000-000000000001';
const POST = '50000000-0000-4000-8000-000000000001';
const user: AuthedUser = { uid: ME, displayName: 'わたし' };

type Q = { q: string; values: unknown[] };
type Handler = (q: string, values: unknown[]) => unknown[] | undefined;
function fakeSql(queries: Q[], handler: Handler): Sql {
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('$');
    queries.push({ q, values });
    const r = handler(q, values);
    if (r === undefined) throw new Error(`fakeSql: 未対応のクエリ: ${q}`);
    return Promise.resolve(r);
  };
  const fn = (first: unknown, ...rest: unknown[]) =>
    Array.isArray(first) && 'raw' in (first as object)
      ? tag(first as unknown as TemplateStringsArray, ...rest)
      : { __obj: first };
  return Object.assign(fn, { unsafe: (s: string) => ({ __unsafe: s }), json: (v: unknown) => v }) as unknown as Sql;
}
const req = (method: string, body?: unknown, url = 'http://x/api') =>
  new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });

// ---- ④ 形質の分離 -----------------------------------------------------------

describe('summarizeOffspring', () => {
  it('選択肢・文字は値ごとの本数（多い順）、数値は最小・最大・平均。記録の無い子と不正な値は数えない', () => {
    const stats = summarizeOffspring([
      { flower_color: 'ピンク', plant_height_cm: 50, repeat_bloom: '四季咲き' },
      { flower_color: 'ピンク', plant_height_cm: 70 },
      { flower_color: '白', plant_height_cm: 91, repeat_bloom: '一季咲き' },
      { flower_color: 'ピンク', repeat_bloom: 'たまに' }, // 不正な値は数えない
      {},
    ]);
    expect(stats).toEqual([
      { key: 'flower_color', label: '花色', type: 'category', recorded: 4, counts: [{ value: 'ピンク', n: 3 }, { value: '白', n: 1 }] },
      { key: 'plant_height_cm', label: '草丈', type: 'number', recorded: 3, min: 50, max: 91, avg: 70.3, unit: 'cm' },
      {
        key: 'repeat_bloom',
        label: '四季性',
        type: 'category',
        recorded: 2,
        counts: [{ value: '一季咲き', n: 1 }, { value: '四季咲き', n: 1 }],
      },
    ]);
  });
});

describe('GET /api/analytics/segregation（有料）', () => {
  it.each(['free', 'canceled'])('%s は 402 で集計しない', async (status) => {
    const queries: Q[] = [];
    const sql = fakeSql(queries, (q) => (q.includes('subscription_status') ? [{ subscription_status: status }] : undefined));
    expect((await handleSegregation(sql, user)).status).toBe(402);
    expect(queries).toHaveLength(1);
  });

  it('交配ごとに子をまとめ、両親の特性を添える。すべて自分の uid で絞る', async () => {
    const queries: Q[] = [];
    const sql = fakeSql(queries, (q) => {
      if (q.includes('subscription_status')) return [{ subscription_status: 'active' }];
      if (q.includes('from pollenia.plants p')) {
        return [
          { crossing_id: 'x1', seed_parent_id: 'm', pollen_parent_id: 'f', cross_date: '2025-05-10', traits: { flower_color: 'ピンク' } },
          { crossing_id: 'x1', seed_parent_id: 'm', pollen_parent_id: 'f', cross_date: '2025-05-10', traits: { flower_color: '白' } },
        ];
      }
      if (q.includes('select id, name, traits from pollenia.plants')) {
        return [
          { id: 'm', name: '母', traits: { flower_color: 'ピンク' } },
          { id: 'f', name: '父', traits: {} },
        ];
      }
      return undefined;
    });
    const res = await handleSegregation(sql, user);
    const body = (await res.json()) as { crossings: Record<string, unknown>[] };
    expect(body.crossings).toEqual([
      {
        crossing_id: 'x1',
        cross_date: '2025-05-10',
        self: false,
        seed_parent: { id: 'm', name: '母', traits: [{ key: 'flower_color', label: '花色', text: 'ピンク' }] },
        pollen_parent: { id: 'f', name: '父', traits: [] },
        offspring: 2,
        traits: [
          { key: 'flower_color', label: '花色', type: 'category', recorded: 2, counts: [{ value: 'ピンク', n: 1 }, { value: '白', n: 1 }] },
        ],
      },
    ]);
    const main = queries.find((x) => x.q.includes('from pollenia.plants p'))!;
    expect(main.q.match(/user_id = \$::uuid/g)).toHaveLength(4);
    expect(main.q).toContain('deleted_at is null');
    for (const { q, values } of queries.slice(1)) {
      expect(q).toMatch(/user_id = \$::uuid/);
      expect(values).toContain(ME);
    }
  });
});

// ---- ⑥ 在庫 ------------------------------------------------------------------

describe('種・花粉の在庫', () => {
  it('作成は種類と名前が必須。自分の uid で作る', async () => {
    const queries: Q[] = [];
    const sql = fakeSql(queries, (q) => (q.includes('insert into pollenia.seed_stocks') ? [{ id: STOCK }] : undefined));
    expect((await handleCreateSeedStock(req('POST', { label: 'A' }), sql, user)).status).toBe(400);
    const ok = await handleCreateSeedStock(
      req('POST', { kind: 'seed', label: 'ピンク実生', quantity: 30, use_by: '2027-03-01' }),
      sql,
      user,
    );
    expect(ok.status).toBe(201);
    expect(queries.at(-1)!.values[0]).toEqual({
      __obj: { user_id: ME, kind: 'seed', label: 'ピンク実生', quantity: 30, use_by: '2027-03-01' },
    });
  });

  it.each([
    [{ kind: 'bulb', label: 'A' }, 'kind'],
    [{ kind: 'seed', label: '' }, '名前'],
    [{ kind: 'seed', label: 'A', quantity: -1 }, '数量'],
    [{ kind: 'seed', label: 'A', use_by: '2027-02-30' }, '使用期限'],
  ])('不正な入力は 400: %j', async (body, expected) => {
    const res = await handleCreateSeedStock(req('POST', body), fakeSql([], () => []), user);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain(expected);
  });

  it('交配は自分の記録だけ紐づけられる', async () => {
    const sql = fakeSql([], (q) => (q.includes('from pollenia.crossings') ? [] : undefined));
    const res = await handleCreateSeedStock(
      req('POST', { kind: 'seed', label: 'A', crossing_id: '20000000-0000-4000-8000-000000000001' }),
      sql,
      user,
    );
    expect(res.status).toBe(400);
  });

  it('更新・削除は自分の在庫だけ（他人は 404）', async () => {
    const queries: Q[] = [];
    const sql = fakeSql(queries, (q) => (q.includes('update') || q.includes('delete') ? [] : undefined));
    expect((await handleUpdateSeedStock(req('PATCH', { quantity: 3 }), sql, user, STOCK)).status).toBe(404);
    expect((await handleDeleteSeedStock(sql, user, STOCK)).status).toBe(404);
    for (const { q, values } of queries) {
      expect(q).toMatch(/where id = \$::uuid and user_id = \$::uuid/);
      expect(values).toContain(ME);
    }
  });
});

// ---- ⑥ 交換 ------------------------------------------------------------------

function exchangeSql(queries: Q[], stock: Record<string, unknown> | null) {
  return fakeSql(queries, (q) => {
    if (q.includes('from pollenia.seed_stocks')) return stock ? [stock] : [];
    if (q.includes('from pollenia.posts')) return [];
    if (q.includes('insert into pollenia.posts')) {
      return [{ id: POST, user_id: ME, content: 'c', visibility: 'public', exchange_type: 'offer', exchange_status: 'open', exchange_label: 'L', seed_stock_id: STOCK }];
    }
    // serializePosts
    if (q.includes('from pollenia.profiles')) return [{ id: ME, display_name: 'わたし' }];
    if (q.includes('from pollenia.likes') || q.includes('from pollenia.comments')) return [];
    return undefined;
  });
}
const STOCK_ROW = { id: STOCK, kind: 'seed', label: 'ピンク実生', species: 'Rosa', use_by: '2099-01-01', quantity: 10 };

describe('POST /api/exchange', () => {
  it('譲ります: 登録品種の確認が無ければ出せない', async () => {
    const queries: Q[] = [];
    const res = await handleCreateExchange(
      req('POST', { type: 'offer', stock_id: STOCK, content: 'どうぞ' }),
      exchangeSql(queries, STOCK_ROW),
      user,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain('種苗法');
    expect(queries).toHaveLength(0);
  });

  it('譲ります: 自分の在庫から、その時点の内容をコピーして公開の投稿にする', async () => {
    const queries: Q[] = [];
    const res = await handleCreateExchange(
      req('POST', { type: 'offer', stock_id: STOCK, content: 'どうぞ', confirm_variety: true }),
      exchangeSql(queries, STOCK_ROW),
      user,
    );
    expect(res.status).toBe(201);
    const stockQ = queries.find((x) => x.q.includes('from pollenia.seed_stocks'))!;
    expect(stockQ.q).toMatch(/user_id = \$::uuid/);
    expect(stockQ.values).toEqual([STOCK, ME]);
    const ins = queries.find((x) => x.q.includes('insert into pollenia.posts'))!;
    expect(ins.q).toContain("'public', $, 'open'");
    // 最後の値は返す列（sql.unsafe）
    expect(ins.values.slice(0, 8)).toEqual([ME, 'どうぞ', 'offer', 'seed', 'ピンク実生', 'Rosa', '2099-01-01', STOCK]);
  });

  it.each([
    [null, '自分のもの'],
    [{ ...STOCK_ROW, use_by: '2000-01-01' }, '使用期限'],
    [{ ...STOCK_ROW, quantity: 0 }, '数量が 0'],
  ])('譲ります: 他人の在庫・期限切れ・数量 0 は出せない', async (stock, expected) => {
    const res = await handleCreateExchange(
      req('POST', { type: 'offer', stock_id: STOCK, content: 'x', confirm_variety: true }),
      exchangeSql([], stock),
      user,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain(expected);
  });

  it('探しています: 名前と本文が必須。在庫は使わない', async () => {
    const queries: Q[] = [];
    expect((await handleCreateExchange(req('POST', { type: 'want', content: 'x' }), exchangeSql(queries, null), user)).status).toBe(400);
    const res = await handleCreateExchange(
      req('POST', { type: 'want', label: '青い花粉', kind: 'pollen', content: '探しています' }),
      exchangeSql(queries, null),
      user,
    );
    expect(res.status).toBe(201);
    expect(queries.some((x) => x.q.includes('seed_stocks'))).toBe(false);
    const ins = queries.find((x) => x.q.includes('insert into pollenia.posts'))!;
    expect(ins.values.slice(0, 8)).toEqual([ME, '探しています', 'want', 'pollen', '青い花粉', null, null, null]);
  });

  it('type が不正なら 400', async () => {
    expect((await handleCreateExchange(req('POST', { type: 'sell', content: 'x' }), exchangeSql([], null), user)).status).toBe(400);
  });
});

describe('GET / PATCH /api/exchange', () => {
  it('一覧は受付中・public・指定の種類だけ', async () => {
    const queries: Q[] = [];
    await handleListExchange(req('GET', undefined, 'http://x/api/exchange?type=want'), exchangeSql(queries, null), user);
    expect(queries[0].q).toContain("exchange_status = 'open' and visibility = 'public'");
    expect(queries[0].values[1]).toBe('want'); // values[0] は列の一覧（sql.unsafe）
  });

  it('受付の終了は本人の交換の投稿だけ（他人・普通の投稿は 404）', async () => {
    const queries: Q[] = [];
    const sql = fakeSql(queries, (q) => (q.includes('update pollenia.posts') ? [] : undefined));
    expect((await handleUpdateExchange(req('PATCH', { status: 'closed' }), sql, user, POST)).status).toBe(404);
    expect(queries[0].q).toContain('user_id = $::uuid and exchange_type is not null');
    expect((await handleUpdateExchange(req('PATCH', { status: 'sold' }), sql, user, POST)).status).toBe(400);
  });
});

describe('serializePosts の交換の枠', () => {
  it('在庫への参照（seed_stock_id）は本人にだけ返す', async () => {
    const post = {
      id: POST, user_id: ME, content: 'c', visibility: 'public', crossing_id: null,
      exchange_type: 'offer', exchange_status: 'open', exchange_kind: 'seed', exchange_label: 'L',
      exchange_species: null, exchange_use_by: null, seed_stock_id: STOCK,
    };
    const sql = exchangeSql([], null);
    const [mine] = await serializePosts(sql, ME, [post]);
    const [theirs] = await serializePosts(sql, OTHER, [post]);
    expect((mine.exchange as Record<string, unknown>).seed_stock_id).toBe(STOCK);
    expect(theirs.exchange).not.toHaveProperty('seed_stock_id');
    expect(theirs.exchange).toMatchObject({ type: 'offer', status: 'open', kind: 'seed', label: 'L' });
  });
});
