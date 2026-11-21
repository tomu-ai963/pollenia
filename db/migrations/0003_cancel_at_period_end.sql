-- 0003: 解約予約（期間の終わりで終わる予定）を profiles に持つ（2026-11-21）。
--
-- これまでは subscription_status と current_period_end だけを持っていたため、カスタマーポータルで
-- 解約を予約しても、期間の終わりまで画面が「加入中（次回更新: …）」のままだった（次回の更新は起きない）。
--
-- Stripe の API 2026-11-18 では、ポータルで解約すると cancel_at_period_end は false のままで、cancel_at に
-- 期間の終わりの日時が入る。Webhook（worker/src/routes/billing.ts の endsAtPeriodEnd）が、
-- cancel_at_period_end = true、または cancel_at が今の期間の終わり以前のときに true にする。
-- 解約の確定（customer.subscription.deleted）で false に戻す。
alter table pollenia.profiles
  add column cancel_at_period_end boolean not null default false;
