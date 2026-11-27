import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 「次の作業」画面（frontend/src/tasks.js）と記録の入力（record-actions.js）。

const FRONT = new URL('../../frontend/', import.meta.url);
type TasksUi = {
  daysBetween: (a: string, b: string) => number;
  dueStatus: (due: string | null, today: string) => string | null;
  dueLabel: (due: string, today: string) => string;
  taskTitle: (t: Record<string, unknown>) => string;
};
type Actions = { localToday: (now?: Date) => string; parseCount: (input: string, what: string) => number };
const { daysBetween, dueStatus, dueLabel, taskTitle } = (await import(
  new URL('src/tasks.js', FRONT).href
)) as TasksUi;
const { localToday, parseCount } = (await import(new URL('src/record-actions.js', FRONT).href)) as Actions;
const read = (name: string) => readFileSync(new URL(name, FRONT), 'utf8');

describe('期日', () => {
  it('日数の差（月またぎ・うるう年）', () => {
    expect(daysBetween('2026-11-27', '2026-12-04')).toBe(7);
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(daysBetween('2026-11-27', '2026-11-20')).toBe(-7);
  });

  it('過ぎた / 7日以内 / それより先 / 期日なし', () => {
    const today = '2026-11-27';
    expect(dueStatus('2026-11-26', today)).toBe('overdue');
    expect(dueStatus('2026-11-27', today)).toBe('soon');
    expect(dueStatus('2026-12-04', today)).toBe('soon');
    expect(dueStatus('2026-12-05', today)).toBe('later');
    expect(dueStatus(null, today)).toBeNull();
  });

  it('表示', () => {
    expect(dueLabel('2026-11-27', '2026-11-27')).toBe('今日');
    expect(dueLabel('2026-11-30', '2026-11-27')).toBe('あと3日');
    expect(dueLabel('2026-11-22', '2026-11-27')).toBe('5日過ぎ');
  });
});

describe('taskTitle', () => {
  const base = { seed_parent_id: 'a', seed_parent_name: 'A', pollen_parent_id: 'b', pollen_parent_name: 'B', count: null };
  it('種類・交配・粒数', () => {
    expect(taskTitle({ ...base, kind: 'harvest' })).toBe('採種: A × B');
    expect(taskTitle({ ...base, kind: 'sow', count: 50, pollen_parent_id: null, pollen_parent_name: null })).toBe('播種: A × （父不明）（50粒）');
    expect(taskTitle({ ...base, kind: 'germination', count: 20, pollen_parent_id: 'a' })).toBe('発芽の確認: A 🌼 自家受粉（20粒）');
  });
});

describe('record-actions', () => {
  it('今日は端末の暦で決める（UTC にしない。日本の朝 8 時でも前日にならない）', () => {
    expect(localToday(new Date(2026, 10, 27, 8, 0))).toBe('2026-11-27');
    expect(localToday(new Date(2026, 0, 5, 0, 1))).toBe('2026-01-05');
  });

  it('数の入力は 0 以上の整数だけ（これまでは不正な入力が 0 粒で保存されていた）', () => {
    expect(parseCount('12', '採種数')).toBe(12);
    expect(parseCount(' 0 ', '採種数')).toBe(0);
    for (const bad of ['', 'abc', '-1', '1.5']) {
      expect(() => parseCount(bad, '採種数')).toThrow('採種数は 0 以上の整数で入力してください。');
    }
  });

  it('交配記録一覧も「次の作業」も同じ入力処理を使う', () => {
    const app = read('src/app.js');
    expect(app).toContain('recordHarvest(c.id)');
    expect(app).not.toMatch(/api\.create(Harvest|Sowing)\(/);
    expect(read('src/tasks.js')).toMatch(/recordHarvest\(t\.record_id\)/);
  });

  it('利用者の入力（個体名）を innerHTML で描かない', () => {
    expect(read('src/tasks.js')).not.toMatch(/innerHTML/);
  });
});
