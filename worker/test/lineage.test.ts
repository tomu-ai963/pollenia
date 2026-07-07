import { describe, expect, it } from 'vitest';
import { collectVisiblePlantIds, type LineageEdge } from '../src/services/lineage';

// README「掟」7 の検証: 名前・写真を join してよいのは RPC が返した可視 plant_id だけ。
// 非可視の親（RPC 側で NULL 化済み）が join 対象に混入しないことを確認する。

const ENTRY = 'e0000000-0000-4000-8000-000000000000';
const CHILD = 'c0000000-0000-4000-8000-000000000000';
const SEED = 'a0000000-0000-4000-8000-000000000000';
const POLLEN = 'b0000000-0000-4000-8000-000000000000';

function edge(partial: Partial<LineageEdge>): LineageEdge {
  return {
    plant_id: CHILD,
    crossing_id: 'f0000000-0000-4000-8000-000000000000',
    seed_parent_id: null,
    pollen_parent_id: null,
    depth: 1,
    has_hidden_parent: false,
    ...partial,
  };
}

describe('collectVisiblePlantIds', () => {
  it('エントリ個体は RPC が0行でも含まれる', () => {
    expect(collectVisiblePlantIds(ENTRY, [])).toEqual([ENTRY]);
  });

  it('可視な親は含まれる', () => {
    const ids = collectVisiblePlantIds(ENTRY, [
      edge({ seed_parent_id: SEED, pollen_parent_id: POLLEN }),
    ]);
    expect(ids).toContain(CHILD);
    expect(ids).toContain(SEED);
    expect(ids).toContain(POLLEN);
  });

  it('非可視の親（NULL 化済み）は join 対象に混入しない', () => {
    // 片親 private のケース: RPC は pollen_parent_id を NULL にし has_hidden_parent を立てる
    const ids = collectVisiblePlantIds(ENTRY, [
      edge({ seed_parent_id: SEED, pollen_parent_id: null, has_hidden_parent: true }),
    ]);
    expect(ids).toEqual(expect.arrayContaining([ENTRY, CHILD, SEED]));
    expect(ids).not.toContain(POLLEN);
    expect(ids).toHaveLength(3);
  });

  it('重複は除去される（自家受粉: 両親が同一個体）', () => {
    const ids = collectVisiblePlantIds(ENTRY, [
      edge({ seed_parent_id: SEED, pollen_parent_id: SEED }),
      edge({ plant_id: SEED, depth: 2 }),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([ENTRY, CHILD, SEED]));
  });
});
