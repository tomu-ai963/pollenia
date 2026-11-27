import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 発芽率の集計画面（frontend/src/germination.js）の表示の組み立て。

const FRONT = new URL('../../frontend/', import.meta.url);
type Ui = {
  formatRate: (r: number | null) => string;
  crossingLabel: (c: Record<string, unknown>) => string;
  statsDetail: (s: Record<string, unknown>) => string;
};
const modulePath: string = new URL('src/germination.js', FRONT).href;
const { formatRate, crossingLabel, statsDetail } = (await import(modulePath)) as Ui;
const read = (name: string) => readFileSync(new URL(name, FRONT), 'utf8');

describe('formatRate', () => {
  it('率を % に丸め、記録なしは —（0% と区別する）', () => {
    expect(formatRate(2 / 3)).toBe('67%');
    expect(formatRate(0)).toBe('0%');
    expect(formatRate(1)).toBe('100%');
    expect(formatRate(null)).toBe('—');
  });
});

describe('crossingLabel', () => {
  it('通常・父不明・自家受粉', () => {
    expect(crossingLabel({ seed_parent_id: 'a', seed_parent_name: 'A', pollen_parent_id: 'b', pollen_parent_name: 'B' })).toBe('A × B');
    expect(crossingLabel({ seed_parent_id: 'a', seed_parent_name: 'A', pollen_parent_id: null })).toBe('A × （父不明）');
    expect(crossingLabel({ seed_parent_id: 'a', seed_parent_name: 'A', pollen_parent_id: 'a' })).toBe('A 🌼 自家受粉');
  });
});

describe('statsDetail', () => {
  it('粒数・平均日数・未記録を並べる', () => {
    expect(statsDetail({ sown: 20, germinated: 15, avg_days_to_germination: 12, pending_sowings: 1 })).toBe(
      '20粒中15本・発芽まで平均12日・発芽未記録1件',
    );
    expect(statsDetail({ sown: 0, germinated: 0, avg_days_to_germination: null, pending_sowings: 2 })).toBe('発芽未記録2件');
  });
});

describe('画面', () => {
  it('利用者の入力（個体名）を innerHTML で描かない', () => {
    expect(read('src/germination.js')).not.toMatch(/innerHTML/);
  });

  it('交配記録一覧から発芽数を入れられる（PATCH /api/sowings/:id）', () => {
    expect(read('src/app.js')).toContain("action('発芽を記録', () => recordGermination(target))");
    expect(read('src/record-actions.js')).toMatch(/api\.updateSowing\(sowing\.id, patch\)/);
  });
});
