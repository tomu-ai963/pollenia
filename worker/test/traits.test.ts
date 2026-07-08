import { describe, expect, it } from 'vitest';
import { parsePlantTraits } from '../src/lib/traits';

function ok(input: unknown): Record<string, unknown> {
  const r = parsePlantTraits(input);
  if (!r.ok) throw new Error(`expected ok, got: ${r.message}`);
  return r.value;
}

describe('parsePlantTraits', () => {
  it('未指定・null は空オブジェクト', () => {
    expect(ok(undefined)).toEqual({});
    expect(ok(null)).toEqual({});
  });

  it('全項目を正規化して通す', () => {
    expect(
      ok({
        bloom_season: 'spring',
        fragrance_strength: 3,
        fragrance_type: '柑橘系',
        plant_height_cm: 45,
        flower_size_cm: 6.5,
      }),
    ).toEqual({
      bloom_season: 'spring',
      fragrance_strength: 3,
      fragrance_type: '柑橘系',
      plant_height_cm: 45,
      flower_size_cm: 6.5,
    });
  });

  it('空欄（null/undefined）のキーは落とす', () => {
    expect(
      ok({ bloom_season: 'summer', fragrance_type: null, plant_height_cm: undefined }),
    ).toEqual({ bloom_season: 'summer' });
  });

  it('fragrance_type は trim される', () => {
    expect(ok({ fragrance_type: '  バニラ系  ' })).toEqual({ fragrance_type: 'バニラ系' });
  });

  it('オブジェクト以外は拒否', () => {
    expect(parsePlantTraits('x').ok).toBe(false);
    expect(parsePlantTraits(42).ok).toBe(false);
    expect(parsePlantTraits([]).ok).toBe(false);
    expect(parsePlantTraits(['spring']).ok).toBe(false);
  });

  it('未知キーは拒否（AI 参照列に不定形を溜めない）', () => {
    expect(parsePlantTraits({ evil: 'x' }).ok).toBe(false);
    expect(parsePlantTraits({ bloom_season: 'spring', extra: 1 }).ok).toBe(false);
  });

  it('bloom_season は列挙値のみ', () => {
    expect(parsePlantTraits({ bloom_season: 'haru' }).ok).toBe(false);
    expect(parsePlantTraits({ bloom_season: 'SPRING' }).ok).toBe(false);
    expect(parsePlantTraits({ bloom_season: 5 }).ok).toBe(false);
    expect(ok({ bloom_season: 'early_summer' })).toEqual({ bloom_season: 'early_summer' });
  });

  it('fragrance_strength は 0〜5 の整数のみ', () => {
    expect(ok({ fragrance_strength: 0 })).toEqual({ fragrance_strength: 0 });
    expect(ok({ fragrance_strength: 5 })).toEqual({ fragrance_strength: 5 });
    expect(parsePlantTraits({ fragrance_strength: -1 }).ok).toBe(false);
    expect(parsePlantTraits({ fragrance_strength: 6 }).ok).toBe(false);
    expect(parsePlantTraits({ fragrance_strength: 2.5 }).ok).toBe(false);
    expect(parsePlantTraits({ fragrance_strength: '3' }).ok).toBe(false);
  });

  it('数値項目は 0 超・有限・上限内のみ', () => {
    expect(parsePlantTraits({ plant_height_cm: 0 }).ok).toBe(false);
    expect(parsePlantTraits({ plant_height_cm: -3 }).ok).toBe(false);
    expect(parsePlantTraits({ plant_height_cm: Infinity }).ok).toBe(false);
    expect(parsePlantTraits({ plant_height_cm: NaN }).ok).toBe(false);
    expect(parsePlantTraits({ plant_height_cm: 10_001 }).ok).toBe(false);
    expect(parsePlantTraits({ flower_size_cm: 1_001 }).ok).toBe(false);
    expect(parsePlantTraits({ flower_size_cm: '5' }).ok).toBe(false);
  });

  it('fragrance_type は空文字・超過を拒否', () => {
    expect(parsePlantTraits({ fragrance_type: '   ' }).ok).toBe(false);
    expect(parsePlantTraits({ fragrance_type: 'あ'.repeat(201) }).ok).toBe(false);
    expect(parsePlantTraits({ fragrance_type: 123 }).ok).toBe(false);
  });
});
