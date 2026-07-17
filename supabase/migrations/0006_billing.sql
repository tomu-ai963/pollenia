-- Phase 4: 課金（Stripe 月額サブスク ¥300/月）
--
-- 方針:
--   * サブスク状態は Supabase 側（pollenia.profiles）で管理する。KV 等の外部ストアは使わない。
--   * 認可の実体は 0002 と同じく Worker（postgres.js 直接続 + service_role）が担い、
--     ここでも deny-all RLS を維持する（profiles は 0002 で RLS 有効済み。新規カラムを足すだけ）。
--   * Anthropic 呼び出し（/api/ai/*）は subscription_status が有料相当のときだけ許可する。
--     判定ロジックは Worker（lib/stripe.ts の isEntitled）に集約する。
--
-- subscription_status の意味:
--   free      … 未加入（既定）。AI 機能は 402。
--   active    … 課金中（初回契約・継続課金成功）。AI 機能を許可。
--   past_due  … 支払い失敗の猶予中（Stripe の自動リトライ期間）。AI 機能は許可し続ける
--               （即時停止しない。Stripe がリトライを打ち切ると .deleted / unpaid で free/canceled に落ちる）。
--   canceled  … 解約確定・回収不能で終了。AI 機能は 402。

alter table pollenia.profiles
  add column subscription_status text not null default 'free'
    check (subscription_status in ('free', 'active', 'past_due', 'canceled')),
  -- Stripe Customer（cus_...）。Webhook は基本これで対象プロフィールを引く。
  add column stripe_customer_id text,
  -- Stripe Subscription（sub_...）。解約時は null に戻す。
  add column stripe_subscription_id text,
  -- 現在の課金期間の終了（＝次回更新日時）。UI 表示・期限切れの参考情報。
  -- Webhook（customer.subscription.created/updated）で同期し、解約（.deleted）で null に戻す。
  -- 利用可否の判定は subscription_status が正であり、このカラムでは判定しない
  -- （Stripe の dunning 設定に猶予を委譲する方針。routes/billing.ts 参照）。
  add column current_period_end timestamptz;

-- Webhook（invoice.* / customer.subscription.*）は stripe_customer_id で対象を特定する。
-- 1 Customer = 1 Pollenia ユーザーなので一意（NULL は複数許容の部分インデックス）。
create unique index idx_profiles_stripe_customer on pollenia.profiles (stripe_customer_id)
  where stripe_customer_id is not null;
