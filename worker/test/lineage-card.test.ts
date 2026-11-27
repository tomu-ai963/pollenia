import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 系統カード画像（frontend/src/lineage-card.js）の中身の組み立て。描画そのものは canvas が要るので、
// 載せる内容（系統・特性・文字の切り詰め・ファイル名）と「URL・QR を入れない」ことを確かめる。

const FRONT = new URL('../../frontend/', import.meta.url);
type Slot = { kind: string; name?: string; species?: string | null };
type Card = {
  traitLines: (t?: Record<string, unknown>) => string[];
  buildPedigree: (
    id: string,
    l: { edges: Record<string, unknown>[]; nodes: Record<string, Record<string, unknown>> },
  ) => { hasParents: boolean; self: boolean; mother: Slot; father: Slot; grand: Slot[] };
  fitText: (t: string, max: number, measure: (s: string) => number) => string;
  cardFileName: (name: string) => string;
};
const { traitLines, buildPedigree, fitText, cardFileName } = (await import(
  new URL('src/lineage-card.js', FRONT).href
)) as Card;
const read = (name: string) => readFileSync(new URL(name, FRONT), 'utf8');

const node = (name: string, species: string | null = null) => ({ name, species, deleted: false, photo_url: null });

describe('buildPedigree', () => {
  const nodes = {
    me: node('私の実生'),
    mom: node('母株', 'Rosa'),
    dad: node('父株'),
    mm: node('母の母'),
    dm: node('父の母'),
  };

  it('両親と祖父母を並べる。父不明・記録なし・非公開を分ける', () => {
    const p = buildPedigree('me', {
      nodes,
      edges: [
        { plant_id: 'me', seed_parent_id: 'mom', pollen_parent_id: 'dad', has_hidden_parent: false },
        { plant_id: 'mom', seed_parent_id: 'mm', pollen_parent_id: null, has_hidden_parent: false }, // 父不明
        { plant_id: 'dad', seed_parent_id: 'dm', pollen_parent_id: null, has_hidden_parent: true }, // 非公開の親
      ],
    });
    expect(p.hasParents).toBe(true);
    expect(p.self).toBe(false);
    expect(p.mother).toEqual({ kind: 'plant', name: '母株', species: 'Rosa' });
    expect(p.father).toEqual({ kind: 'plant', name: '父株', species: null });
    expect(p.grand.map((g) => g.kind)).toEqual(['plant', 'unknown', 'plant', 'hidden']);
  });

  it('導入株（親の記録なし）', () => {
    const p = buildPedigree('me', { nodes, edges: [] });
    expect(p.hasParents).toBe(false);
    expect(p.grand.every((g) => g.kind === 'none')).toBe(true);
  });

  it('自家受粉', () => {
    const p = buildPedigree('me', {
      nodes,
      edges: [{ plant_id: 'me', seed_parent_id: 'mom', pollen_parent_id: 'mom', has_hidden_parent: false }],
    });
    expect(p.self).toBe(true);
    expect(p.father).toMatchObject({ kind: 'plant', name: '母株' });
  });

  it('nodes に無い ID の名前は出さない（非公開扱い）', () => {
    const p = buildPedigree('me', {
      nodes: { me: node('私') },
      edges: [{ plant_id: 'me', seed_parent_id: 'secret', pollen_parent_id: null, has_hidden_parent: false }],
    });
    expect(p.mother).toEqual({ kind: 'hidden' });
  });
});

describe('traitLines', () => {
  it('記録のある特性だけを載せる（0 も載せる）', () => {
    expect(traitLines({ bloom_season: 'early_summer', fragrance_strength: 0, flower_size_cm: 8.5 })).toEqual([
      '開花時期　初夏',
      '花のサイズ　8.5 cm',
      '香りの強さ　0 / 5',
    ]);
    expect(traitLines({})).toEqual([]);
    expect(traitLines()).toEqual([]);
  });
});

describe('fitText', () => {
  const measure = (s: string) => s.length * 10;
  it('収まるならそのまま、はみ出すなら … で切る', () => {
    expect(fitText('あいう', 30, measure)).toBe('あいう');
    expect(fitText('あいうえおかきく', 50, measure)).toBe('あいうえ…');
    expect(measure(fitText('あいうえおかきく', 50, measure))).toBeLessThanOrEqual(50);
  });
});

describe('cardFileName', () => {
  it('OS で使えない文字を外す', () => {
    expect(cardFileName('ローズ/A:1*')).toBe('ローズA1_系統カード.png');
    expect(cardFileName('///')).toBe('plant_系統カード.png');
  });
});

describe('出品先の規約への配慮', () => {
  it('カードに URL・QR を描かない', () => {
    const src = read('src/lineage-card.js');
    expect(src).not.toMatch(/qrcode|plant-link|tomu-ai\.dev|https?:\/\//);
  });
});
