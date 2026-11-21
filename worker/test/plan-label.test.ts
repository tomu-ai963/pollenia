import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 「AI相談」タブのプランの表示（frontend/src/plan-label.js）。
// 解約を予約した人に「次回更新」と出さない（2026-11-21。ポータルで解約しても期間の終わりまで
// 「加入中（次回更新: …）」のままだった）。frontend はビルドなしの素の JS なので、型を持たせずに読み込む。

const FRONT = new URL('../../frontend/src/', import.meta.url);
type PlanLabel = { planLabel: (me: unknown) => string };
const modulePath: string = new URL('plan-label.js', FRONT).href;
const { planLabel } = (await import(modulePath)) as PlanLabel;

const END = '2026-12-21T07:18:39.000Z';

describe('planLabel', () => {
  it('加入中で解約予約なし → 次回更新日', () => {
    expect(planLabel({ subscription_status: 'active', current_period_end: END, cancel_at_period_end: false })).toBe(
      '現在のプラン: 加入中（有料プラン）（次回更新: 2026/12/21）',
    );
  });

  it('加入中で解約予約あり → 終了予定日。「次回更新」とは出さない', () => {
    const label = planLabel({ subscription_status: 'active', current_period_end: END, cancel_at_period_end: true });
    expect(label).toBe('現在のプラン: 加入中（有料プラン）（2026/12/21 に終了予定。それまではご利用いただけます）');
    expect(label).not.toContain('次回更新');
  });

  it('未加入・解約済みは日付を添えない', () => {
    expect(planLabel({ subscription_status: 'free' })).toBe('現在のプラン: 未加入（無料）');
    expect(planLabel(null)).toBe('現在のプラン: 未加入（無料）');
    expect(planLabel({ subscription_status: 'canceled', current_period_end: END })).toBe('現在のプラン: 解約済み');
  });

  it('お支払い確認中（past_due）も解約予約を出し分ける', () => {
    expect(planLabel({ subscription_status: 'past_due', current_period_end: END, cancel_at_period_end: true })).toContain('に終了予定');
  });
});

describe('app.js は planLabel で表示する', () => {
  it('renderPlan が planLabel(me) を使う（日付の組み立てを app.js に戻さない）', () => {
    const app = readFileSync(fileURLToPath(new URL('app.js', FRONT)), 'utf8');
    expect(app).toMatch(/import \{ planLabel \} from '\.\/plan-label\.js';/);
    expect(app).toMatch(/\$\('plan-status'\)\.textContent = planLabel\(me\);/);
  });
});
