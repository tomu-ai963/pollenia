import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Sql } from '../src/lib/db';
import type { AuthedUser } from '../src/lib/auth';
import { normalizeDate, planImport, IMPORT_MAX_ROWS, type ImportPlan } from '../src/lib/import-plan';
import { handleImportPlants } from '../src/routes/import';

// 過去の記録の CSV 取り込み（lib/import-plan.ts・routes/import.ts・frontend/src/csv-import.js）。

const EXISTING = [
  { id: 'e-mom', name: '登録済みの母' },
  { id: 'e-dup1', name: '同名株' },
  { id: 'e-dup2', name: '同名株' },
];
const ok = (rows: Record<string, unknown>[], existing = EXISTING): ImportPlan => {
  const r = planImport(rows, existing);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.plan;
};
const errs = (rows: Record<string, unknown>[], existing = EXISTING) => {
  const r = planImport(rows, existing);
  if (r.ok) throw new Error('エラーになるはず');
  return r.errors;
};

describe('planImport', () => {
  it('親の名前は CSV の行 → 登録済み → 自動の導入株 の順に探す', () => {
    const plan = ok([
      { name: '子1', mother: '母（CSV）', father: '登録済みの母' },
      { name: '母（CSV）', mother: '' },
      { name: '子2', mother: '知らない株', father: '不明' },
    ]);
    expect(plan.crossings).toEqual([
      { seedKey: 'new:母（CSV）', pollenKey: 'existing:e-mom', crossDate: null, childKeys: ['new:子1'] },
      { seedKey: 'new:知らない株', pollenKey: null, crossDate: null, childKeys: ['new:子2'] },
    ]);
    expect(plan.plants.map((p) => [p.name, p.row])).toEqual([
      ['子1', 1],
      ['母（CSV）', 2],
      ['子2', 3],
      ['知らない株', null], // 自動で作る導入株
    ]);
  });

  it('同じ母・父・交配日の兄弟は 1 つの交配にまとめる。交配日が違えば別の交配', () => {
    const plan = ok([
      { name: 'A', mother: 'M', father: 'F', cross_date: '2025/5/10' },
      { name: 'B', mother: 'M', father: 'F', cross_date: '2025-05-10' },
      { name: 'C', mother: 'M', father: 'F', cross_date: '2026-05-10' },
    ]);
    expect(plan.crossings.map((c) => [c.crossDate, c.childKeys])).toEqual([
      ['2025-05-10', ['new:A', 'new:B']],
      ['2026-05-10', ['new:C']],
    ]);
  });

  it('父の欄: 「自家」や母と同じ名前は自家受粉、空・不明は父不明', () => {
    const plan = ok([
      { name: 'A', mother: 'M', father: '自家' },
      { name: 'B', mother: 'M', father: 'M', cross_date: '2025-01-01' },
      { name: 'C', mother: 'M', father: '', cross_date: '2025-02-01' },
      { name: 'D', mother: 'M', father: '父不明', cross_date: '2025-03-01' },
    ]);
    expect(plan.crossings.map((c) => c.pollenKey)).toEqual(['new:M', 'new:M', null, null]);
  });

  it('特性は日本語の開花時期と数値を traits にする', () => {
    const plan = ok([
      { name: 'A', bloom_season: '初夏', fragrance_strength: '4', plant_height_cm: '90.5', fragrance_type: 'ダマスク' },
    ]);
    expect(plan.plants[0].traits).toEqual({
      bloom_season: 'early_summer',
      fragrance_strength: 4,
      plant_height_cm: 90.5,
      fragrance_type: 'ダマスク',
    });
  });

  it.each([
    [[{ name: '' }], '名前は必須'],
    [[{ name: 'A' }, { name: 'A' }], '同じ名前の行'],
    [[{ name: '登録済みの母' }], '二重の取り込み'],
    [[{ name: 'A', father: 'F' }], '母（種子親）も書いて'],
    [[{ name: 'A', mother: 'A' }], '自分自身'],
    [[{ name: 'A', mother: 'M', cross_date: '5月10日' }], '交配日'],
    [[{ name: 'A', cross_date: '2025-05-10' }], '母を書いた行にだけ'],
    [[{ name: 'A', fragrance_strength: '7' }], '香りの強さ'],
    [[{ name: 'A', bloom_season: '梅雨' }], '開花時期'],
    [[{ name: 'A', mother: '同名株' }], '複数登録'],
    [[{ name: 'A', mother: 'B' }, { name: 'B', mother: 'A' }], '輪になって'],
  ])('エラー: %j', (rows, expected) => {
    expect(errs(rows).map((e) => e.message).join('\n')).toContain(expected);
  });

  it('エラーの文言に入力値を入れない（行番号と項目名だけ）', () => {
    const e = errs([{ name: '<script>', mother: '<script>' }]);
    expect(e[0].message).not.toContain('<script>');
  });

  it(`空・${IMPORT_MAX_ROWS} 行を超えるものは取り込まない`, () => {
    expect(errs([])[0].message).toContain('ありません');
    const many = Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => ({ name: `p${i}` }));
    expect(errs(many)[0].message).toContain(`${IMPORT_MAX_ROWS} 行まで`);
  });
});

describe('normalizeDate', () => {
  it('区切りと桁をそろえ、存在しない日は弾く', () => {
    expect(normalizeDate('2025/5/1')).toBe('2025-05-01');
    expect(normalizeDate('2025.12.31')).toBe('2025-12-31');
    expect(normalizeDate('2025-02-30')).toBeNull();
    expect(normalizeDate('R7/5/1')).toBeNull();
  });
});

// ---- ルート --------------------------------------------------------------

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const user: AuthedUser = { uid: ME, displayName: 'わたし' };
type Q = { q: string; values: unknown[] };
function fakeSql(queries: Q[]): Sql {
  let n = 0;
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('$');
    queries.push({ q, values });
    if (q.includes('select id, name from pollenia.plants')) {
      return Promise.resolve([{ id: 'e-mom', name: '登録済みの母' }]);
    }
    if (q.includes('insert into')) return Promise.resolve([{ id: `id${++n}` }]);
    if (q.includes('update pollenia.plants')) return Promise.resolve([]);
    throw new Error(`fakeSql: 未対応のクエリ: ${q}`);
  };
  const sql = Object.assign(tag, {
    json: (v: unknown) => ({ __json: v }),
    begin: async (fn: (tx: unknown) => Promise<unknown>) => {
      queries.push({ q: 'BEGIN', values: [] });
      const r = await fn(sql);
      queries.push({ q: 'COMMIT', values: [] });
      return r;
    },
  });
  return sql as unknown as Sql;
}
const post = (body: unknown, dry = false) =>
  new Request(`http://x/api/import/plants${dry ? '?dry_run=1' : ''}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

describe('POST /api/import/plants', () => {
  const rows = [
    { name: '子1', mother: '登録済みの母', father: '新しい父', cross_date: '2025-05-10' },
    { name: '子2', mother: '登録済みの母', father: '新しい父', cross_date: '2025-05-10' },
  ];

  it('dry_run は書き込まずに作るものを返す', async () => {
    const queries: Q[] = [];
    const res = await handleImportPlants(post({ rows }, true), fakeSql(queries), user);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      dry_run: true,
      summary: { plants: 2, auto_parents: ['新しい父'], crossings: 1 },
    });
    expect(queries.some((x) => /insert|update|BEGIN/.test(x.q))).toBe(false);
  });

  it('本番は 1 つのトランザクションで、個体（private）→ 交配 → 採種 → 播種 → 子をつなぐ', async () => {
    const queries: Q[] = [];
    const res = await handleImportPlants(post({ rows }), fakeSql(queries), user);
    expect(res.status).toBe(201);
    const qs = queries.map((x) => x.q);
    expect(qs[1]).toBe('BEGIN');
    expect(qs.at(-1)).toBe('COMMIT');
    const plantInserts = qs.filter((q) => q.includes('insert into pollenia.plants'));
    expect(plantInserts).toHaveLength(3); // 子1・子2 + 自動で作る父
    for (const q of plantInserts) expect(q).toContain("'private'");
    expect(qs.filter((q) => q.includes('insert into pollenia.crossings'))).toHaveLength(1);
    // 系統をつなぐための採種・播種は「次の作業」に出さない
    for (const q of qs.filter((q) => /insert into pollenia\.(seed_harvests|sowings)/.test(q))) {
      expect(q).toContain('task_dismissed_at');
    }
    expect(qs.filter((q) => q.includes('update pollenia.plants set origin_sowing_id'))).toHaveLength(2);
    // すべての読み書きを自分の uid で
    for (const { q, values } of queries.filter((x) => /insert|update|select/.test(x.q))) {
      expect(values).toContain(ME);
      expect(q).toMatch(/\$::uuid/);
    }
  });

  it('不正な行は 422 で行ごとのエラーを返し、何も書かない', async () => {
    const queries: Q[] = [];
    const res = await handleImportPlants(post({ rows: [{ name: '登録済みの母' }] }), fakeSql(queries), user);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { errors: { row: number }[] }).errors[0].row).toBe(1);
    expect(queries.some((x) => /insert|BEGIN/.test(x.q))).toBe(false);
  });

  it('rows が配列でない・多すぎるものは 400', async () => {
    expect((await handleImportPlants(post({ rows: 'x' }), fakeSql([]), user)).status).toBe(400);
    const many = Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => ({ name: `p${i}` }));
    expect((await handleImportPlants(post({ rows: many }), fakeSql([]), user)).status).toBe(400);
  });
});

// ---- 画面（CSV の読み取り） ------------------------------------------------

const FRONT = new URL('../../frontend/', import.meta.url);
type Csv = {
  decodeCsvBytes: (b: ArrayBuffer | Uint8Array) => string;
  parseCsv: (t: string) => string[][];
  tableToRows: (t: string[][]) => { rows: Record<string, string>[]; unknownHeaders: string[]; hasName: boolean };
};
const csvPath: string = new URL('src/csv-import.js', FRONT).href;
const csv = (await import(csvPath)) as Csv;

describe('csv-import.js', () => {
  it('引用符の中のカンマ・改行・"" と CRLF を読む。空行は落とす', () => {
    expect(csv.parseCsv('名前,メモ\r\n"A, B","1行目\n2行目"\r\n\r\n"say ""hi""",x\r\n')).toEqual([
      ['名前', 'メモ'],
      ['A, B', '1行目\n2行目'],
      ['say "hi"', 'x'],
    ]);
  });

  it('UTF-8（BOM 付き）と Shift_JIS（Excel の CSV）を読む', () => {
    const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('名前\n母')]);
    expect(csv.parseCsv(csv.decodeCsvBytes(utf8))).toEqual([['名前'], ['母']]);
    const sjis = new Uint8Array([0x96, 0xbc, 0x91, 0x4f]); // 「名前」の Shift_JIS
    expect(csv.decodeCsvBytes(sjis)).toBe('名前');
  });

  it('見出しの揺れ（括弧・空白・別名）を吸収し、知らない列は使わない', () => {
    const { rows, unknownHeaders, hasName } = csv.tableToRows([
      ['名前', '母（種子親）', '花粉親', '草丈 (cm)', '色'],
      ['A', 'M', 'F', '90', '赤'],
    ]);
    expect(hasName).toBe(true);
    expect(rows).toEqual([{ name: 'A', mother: 'M', father: 'F', plant_height_cm: '90' }]);
    expect(unknownHeaders).toEqual(['色']);
  });

  it('ひな形の CSV はそのまま取り込める', () => {
    const bytes = readFileSync(new URL('assets/pollenia-import-template.csv', FRONT));
    const { rows, unknownHeaders } = csv.tableToRows(csv.parseCsv(csv.decodeCsvBytes(bytes)));
    expect(unknownHeaders).toEqual([]);
    const r = planImport(rows, []);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.plants.map((p) => p.name)).toContain('父株B');
  });
});
