// 「AI相談」タブのプランの表示（2026-11-21 に app.js の renderPlan から切り出した）。
//
// **解約を予約した人に「次回更新」と出さない。** Webhook（worker/src/routes/billing.ts の endsAtPeriodEnd）が
// profiles.cancel_at_period_end を true にしていれば、期間の終わりで終わる予定なので「終了予定日」を出す。
// 期間の終わりまでは AI 機能を使える（特商法の表記「解約後のご利用」）。

const PLAN_LABEL = {
  active: '加入中（有料プラン）',
  past_due: '加入中（お支払い確認中）',
  canceled: '解約済み',
  free: '未加入（無料）',
};

const SUBSCRIBED = new Set(['active', 'past_due']);

function ymd(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** GET /api/me の profile（または null）→ プランの表示文 */
export function planLabel(me) {
  const status = me?.subscription_status ?? 'free';
  let label = `現在のプラン: ${PLAN_LABEL[status] ?? status}`;
  if (!SUBSCRIBED.has(status)) return label;
  const date = ymd(me?.current_period_end);
  if (!date) return label;
  label += me?.cancel_at_period_end
    ? `（${date} に終了予定。それまではご利用いただけます）`
    : `（次回更新: ${date}）`;
  return label;
}
