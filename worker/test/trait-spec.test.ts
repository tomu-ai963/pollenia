import { describe, expect, it } from 'vitest';
import { GENRES, TRAITS, traitEntries, traitsForGenre, validateTrait } from '../../frontend/src/trait-spec.js';
import { parsePlantTraits } from '../src/lib/traits';
import { planImport } from '../src/lib/import-plan';

// ジャンル別の特性の定義（frontend/src/trait-spec.js。画面と Worker で共有）。

describe('trait-spec', () => {
  it('key も label も重ならない（CSV の見出しを label で対応づけるため）', () => {
    expect(new Set(TRAITS.map((t) => t.key)).size).toBe(TRAITS.length);
    expect(new Set(TRAITS.map((t) => t.label)).size).toBe(TRAITS.length);
  });

  it('どの項目もどれかのジャンルで入力でき、ジャンルは定義済みのものだけ', () => {
    const genres = new Set(GENRES.map((g) => g.value));
    for (const t of TRAITS) {
      expect(t.genres.length).toBeGreaterThan(0);
      for (const g of t.genres) expect(genres.has(g)).toBe(true);
    }
  });

  it('ジャンル未設定・知らない値は「その他」の項目（これまでの個体の入力欄が変わらない）', () => {
    const legacy = ['bloom_season', 'plant_height_cm', 'flower_size_cm', 'fragrance_strength', 'fragrance_type'];
    for (const g of [null, undefined, 'unknown']) {
      const keys = traitsForGenre(g).map((t) => t.key);
      for (const k of legacy) expect(keys).toContain(k);
    }
    expect(traitsForGenre('succulent').map((t) => t.key)).toContain('farina');
    expect(traitsForGenre('succulent').map((t) => t.key)).not.toContain('fragrance_strength');
  });

  it('validateTrait: 選択肢・整数・数値・文字', () => {
    const by = (k: string) => TRAITS.find((t) => t.key === k)!;
    expect(validateTrait(by('repeat_bloom'), '四季咲き')).toEqual({ ok: true, value: '四季咲き' });
    expect(validateTrait(by('repeat_bloom'), '毎日咲き').ok).toBe(false);
    expect(validateTrait(by('petal_count'), 40)).toEqual({ ok: true, value: 40 });
    expect(validateTrait(by('petal_count'), 0).ok).toBe(false);
    expect(validateTrait(by('sugar_brix'), 12.5)).toEqual({ ok: true, value: 12.5 });
    expect(validateTrait(by('sugar_brix'), -1).ok).toBe(false);
    expect(validateTrait(by('leaf_color'), '  赤紫 ')).toEqual({ ok: true, value: '赤紫' });
    expect(validateTrait(by('leaf_color'), '')).toEqual({ ok: true, value: null });
  });

  it('エラー文言に入力値を入れない', () => {
    const r = validateTrait(TRAITS.find((t) => t.key === 'spot')!, '<script>');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain('<script>');
  });

  it('traitEntries は定義の順に表示し、定義に合わない値・知らないキーは出さない', () => {
    expect(traitEntries({ farina: '多い', bloom_season: 'winter', evil: 'x', petal_count: 'many' })).toEqual([
      { key: 'bloom_season', label: '開花時期', text: '冬' },
      { key: 'farina', label: '粉', text: '多い' },
    ]);
  });
});

describe('parsePlantTraits（Worker）', () => {
  it('ジャンル別の項目を受け付け、空欄は落とす', () => {
    expect(parsePlantTraits({ hellebore_form: 'ダブル', picotee: 'あり', nectary_color: '', flower_color: 'ピンク' })).toEqual({
      ok: true,
      value: { hellebore_form: 'ダブル', picotee: 'あり', flower_color: 'ピンク' },
    });
  });
  it('未知キーは拒否', () => {
    expect(parsePlantTraits({ color: 'red' }).ok).toBe(false);
  });
});

describe('CSV 取り込みのジャンル・特性', () => {
  it('ジャンルは表示名でも値でもよく、選択肢は表示名で書ける', () => {
    const r = planImport(
      [
        { name: 'A', genre: 'クリスマスローズ', hellebore_form: 'ダブル', spot: 'ブロッチ', flower_color: '白' },
        { name: 'B', genre: 'succulent', farina: '多い', autumn_color: '強い' },
        { name: 'C', bloom_season: '初夏' },
      ],
      [],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.plants.map((p) => [p.name, p.genre, p.traits])).toEqual([
      ['A', 'hellebore', { hellebore_form: 'ダブル', spot: 'ブロッチ', flower_color: '白' }],
      ['B', 'succulent', { farina: '多い', autumn_color: '強い' }],
      ['C', null, { bloom_season: 'early_summer' }],
    ]);
  });

  it('知らないジャンル・選択肢にない値はエラー', () => {
    const bad = planImport([{ name: 'A', genre: '果樹' }], []);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0].message).toContain('ジャンル');
    const bad2 = planImport([{ name: 'A', farina: 'ふわふわ' }], []);
    expect(bad2.ok).toBe(false);
    if (!bad2.ok) expect(bad2.errors[0].message).toContain('粉');
  });
});
