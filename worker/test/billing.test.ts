import { describe, expect, it } from 'vitest';
import type { Sql } from '../src/lib/db';
import {
  isEntitled,
  mapStripeSubscriptionStatus,
  parseStripeSignatureHeader,
  requireActiveSubscription,
  signStripePayload,
  timingSafeEqualHex,
  toStripeForm,
  verifyStripeWebhook,
} from '../src/lib/stripe';
import { dispatchWebhookEvent, handleCreatePortal } from '../src/routes/billing';
import type { Env } from '../src/env';
import type { AuthedUser } from '../src/lib/auth';

const SECRET = 'whsec_test_secret';
const NOW = 1_700_000_000; // 固定タイムスタンプ（決定的テスト）

// クエリ本文と補間値を記録するフェイク sql。resultFor で戻り値を差し替えられる。
type FakeSql = Sql & { calls: { text: string; values: unknown[] }[] };
function makeFakeSql(resultFor?: (text: string, values: unknown[]) => unknown[]): FakeSql {
  const calls: { text: string; values: unknown[] }[] = [];
  const handler = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ? ');
    calls.push({ text, values });
    return Promise.resolve(resultFor ? resultFor(text, values) : []);
  };
  (handler as unknown as FakeSql).calls = calls;
  return handler as unknown as FakeSql;
}

describe('timingSafeEqualHex', () => {
  it('同一文字列は true、1文字違いは false、長さ違いは false', () => {
    expect(timingSafeEqualHex('abcdef', 'abcdef')).toBe(true);
    expect(timingSafeEqualHex('abcdef', 'abcde0')).toBe(false);
    expect(timingSafeEqualHex('abcdef', 'abcde')).toBe(false);
    expect(timingSafeEqualHex('', '')).toBe(true);
  });
});

describe('parseStripeSignatureHeader', () => {
  it('t と v1（複数可）を取り出す', () => {
    expect(parseStripeSignatureHeader('t=123,v1=aaa,v1=bbb')).toEqual({
      timestamp: 123,
      v1: ['aaa', 'bbb'],
    });
  });
  it('t 欠落・v1 欠落・空は null', () => {
    expect(parseStripeSignatureHeader('v1=aaa')).toBeNull();
    expect(parseStripeSignatureHeader('t=123')).toBeNull();
    expect(parseStripeSignatureHeader('')).toBeNull();
    expect(parseStripeSignatureHeader('t=abc,v1=aaa')).toBeNull(); // t が非数値
    expect(parseStripeSignatureHeader('t=0x10,v1=aaa')).toBeNull(); // 16進など非正準表記を弾く（L4）
    expect(parseStripeSignatureHeader('t=1e3,v1=aaa')).toBeNull(); // 指数表記も弾く（L4）
  });
});

describe('verifyStripeWebhook（署名検証: タイムスタンプ許容窓 + タイミングセーフ比較）', () => {
  const payload = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' });

  it('正しい署名・許容窓内は true', async () => {
    const header = await signStripePayload(payload, SECRET, NOW);
    expect(await verifyStripeWebhook(payload, header, SECRET, 300, NOW)).toBe(true);
  });

  it('ペイロード改竄は false（署名不一致）', async () => {
    const header = await signStripePayload(payload, SECRET, NOW);
    const tampered = payload.replace('invoice.paid', 'invoice.payment_failed');
    expect(await verifyStripeWebhook(tampered, header, SECRET, 300, NOW)).toBe(false);
  });

  it('別シークレットで作った署名は false', async () => {
    const header = await signStripePayload(payload, 'whsec_other', NOW);
    expect(await verifyStripeWebhook(payload, header, SECRET, 300, NOW)).toBe(false);
  });

  it('タイムスタンプが許容窓を超えると false（過去・未来とも）', async () => {
    const header = await signStripePayload(payload, SECRET, NOW);
    // now が署名時刻より 301 秒進んでいる → 窓（300）外
    expect(await verifyStripeWebhook(payload, header, SECRET, 300, NOW + 301)).toBe(false);
    // now が署名時刻より 301 秒過去 → 窓外
    expect(await verifyStripeWebhook(payload, header, SECRET, 300, NOW - 301)).toBe(false);
    // ちょうど窓内（300 秒差）は許可
    expect(await verifyStripeWebhook(payload, header, SECRET, 300, NOW + 300)).toBe(true);
  });

  it('ヘッダ欠落・不正形式は false', async () => {
    expect(await verifyStripeWebhook(payload, null, SECRET, 300, NOW)).toBe(false);
    expect(await verifyStripeWebhook(payload, 'garbage', SECRET, 300, NOW)).toBe(false);
  });

  it('複数 v1 のいずれかが一致すれば true（キーローテーション）', async () => {
    const good = await signStripePayload(payload, SECRET, NOW);
    const goodSig = good.split('v1=')[1];
    const header = `t=${NOW},v1=deadbeef,v1=${goodSig}`;
    expect(await verifyStripeWebhook(payload, header, SECRET, 300, NOW)).toBe(true);
  });
});

describe('mapStripeSubscriptionStatus', () => {
  it('Stripe status を Pollenia の status に写像', () => {
    expect(mapStripeSubscriptionStatus('active')).toBe('active');
    expect(mapStripeSubscriptionStatus('trialing')).toBe('active');
    expect(mapStripeSubscriptionStatus('past_due')).toBe('past_due');
    expect(mapStripeSubscriptionStatus('unpaid')).toBe('past_due');
    expect(mapStripeSubscriptionStatus('canceled')).toBe('canceled');
    expect(mapStripeSubscriptionStatus('incomplete')).toBe('free');
    expect(mapStripeSubscriptionStatus('incomplete_expired')).toBe('free');
    expect(mapStripeSubscriptionStatus('paused')).toBe('free');
  });
});

describe('isEntitled', () => {
  it('active / past_due のみ許可', () => {
    expect(isEntitled('active')).toBe(true);
    expect(isEntitled('past_due')).toBe(true);
    expect(isEntitled('free')).toBe(false);
    expect(isEntitled('canceled')).toBe(false);
    expect(isEntitled(null)).toBe(false);
    expect(isEntitled(undefined)).toBe(false);
  });
});

describe('toStripeForm', () => {
  it('ネストを Stripe のブラケット記法に平坦化', () => {
    const form = toStripeForm({
      mode: 'subscription',
      line_items: [{ price: 'price_1', quantity: 1 }],
      metadata: { uid: 'u1' },
    });
    const params = new URLSearchParams(form);
    expect(params.get('mode')).toBe('subscription');
    expect(params.get('line_items[0][price]')).toBe('price_1');
    expect(params.get('line_items[0][quantity]')).toBe('1');
    expect(params.get('metadata[uid]')).toBe('u1');
  });
});

const UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CUSTOMER = 'cus_123';
const SUBSCRIPTION = 'sub_123';

describe('dispatchWebhookEvent（5イベントのハンドラ）', () => {
  it('checkout.session.completed → active + customer/subscription 紐付け', async () => {
    const sql = makeFakeSql();
    await dispatchWebhookEvent(sql, {
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: UID,
          customer: CUSTOMER,
          subscription: SUBSCRIPTION,
        },
      },
    });
    expect(sql.calls).toHaveLength(1);
    const call = sql.calls[0];
    expect(call.text).toContain("subscription_status = 'active'");
    expect(call.text).toContain('where id =');
    // session.subscription が ID 文字列のときは期間終了は null（.created/.updated 側で同期）
    expect(call.values).toEqual([CUSTOMER, SUBSCRIPTION, null, UID]);
  });

  it('customer.subscription.updated → status 同期（customer で特定）', async () => {
    // customer で引いて 1 行更新 → フォールバックしない
    const sql = makeFakeSql(() => [{ id: UID }]);
    await dispatchWebhookEvent(sql, {
      type: 'customer.subscription.updated',
      data: { object: { id: SUBSCRIPTION, customer: CUSTOMER, status: 'past_due' } },
    });
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].text).toContain('where stripe_customer_id =');
    expect(sql.calls[0].values).toEqual(['past_due', SUBSCRIPTION, null, CUSTOMER]);
  });

  it('customer.subscription.updated → customer 未紐付けは metadata.uid でフォールバック', async () => {
    // returning id のクエリ（customer キー更新）は 0 行 → uid フォールバック
    const sql = makeFakeSql((text) => (text.includes('returning id') ? [] : [{ id: UID }]));
    await dispatchWebhookEvent(sql, {
      type: 'customer.subscription.updated',
      data: {
        object: { id: SUBSCRIPTION, customer: CUSTOMER, status: 'active', metadata: { uid: UID } },
      },
    });
    expect(sql.calls).toHaveLength(2);
    // 2 本目は id で更新し、customer id を coalesce で補完
    expect(sql.calls[1].text).toContain('coalesce(stripe_customer_id');
    expect(sql.calls[1].values).toContain(UID);
    expect(sql.calls[1].values).toContain('active');
  });

  it('customer.subscription.deleted → free + subscription id クリア', async () => {
    const sql = makeFakeSql(() => [{ id: UID }]);
    await dispatchWebhookEvent(sql, {
      type: 'customer.subscription.deleted',
      data: { object: { id: SUBSCRIPTION, customer: CUSTOMER } },
    });
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].text).toContain("subscription_status = 'free'");
    expect(sql.calls[0].text).toContain('stripe_subscription_id = null');
    expect(sql.calls[0].text).toContain('current_period_end = null');
    expect(sql.calls[0].values).toEqual([CUSTOMER]);
  });

  it('invoice.paid → active を維持（順序ガード付き: 既存 active/past_due のみ対象 = M1）', async () => {
    const sql = makeFakeSql();
    await dispatchWebhookEvent(sql, {
      type: 'invoice.paid',
      data: { object: { customer: CUSTOMER } },
    });
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].text).toContain("subscription_status = 'active'");
    // 解約確定後（free/canceled）に遅延到達した paid で復活させないためのガード。
    expect(sql.calls[0].text).toContain("subscription_status in ('active', 'past_due')");
    expect(sql.calls[0].values).toEqual([CUSTOMER]);
  });

  it('checkout.session.completed: 支払い未確定（unpaid）は active 化しない（M2）', async () => {
    const sql = makeFakeSql();
    await dispatchWebhookEvent(sql, {
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: UID,
          customer: CUSTOMER,
          subscription: SUBSCRIPTION,
          mode: 'subscription',
          payment_status: 'unpaid',
        },
      },
    });
    expect(sql.calls).toHaveLength(0);
  });

  it('checkout.session.completed: subscription 以外の mode は無視（M2）', async () => {
    const sql = makeFakeSql();
    await dispatchWebhookEvent(sql, {
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: UID,
          customer: CUSTOMER,
          subscription: SUBSCRIPTION,
          mode: 'payment',
          payment_status: 'paid',
        },
      },
    });
    expect(sql.calls).toHaveLength(0);
  });

  it('checkout.session.completed: mode/payment_status 明示（subscription+paid）は active 化', async () => {
    const sql = makeFakeSql();
    await dispatchWebhookEvent(sql, {
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: UID,
          customer: CUSTOMER,
          subscription: SUBSCRIPTION,
          mode: 'subscription',
          payment_status: 'paid',
        },
      },
    });
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].text).toContain("subscription_status = 'active'");
    expect(sql.calls[0].values).toEqual([CUSTOMER, SUBSCRIPTION, null, UID]);
  });

  it('invoice.payment_failed → past_due（即時停止しない）', async () => {
    const sql = makeFakeSql();
    await dispatchWebhookEvent(sql, {
      type: 'invoice.payment_failed',
      data: { object: { customer: CUSTOMER } },
    });
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].text).toContain("subscription_status = 'past_due'");
    expect(sql.calls[0].values).toEqual([CUSTOMER]);
  });

  it('customer.subscription.created も .updated と同じ写像で処理（初回契約の period 取り込み）', async () => {
    const sql = makeFakeSql(() => [{ id: UID }]);
    await dispatchWebhookEvent(sql, {
      type: 'customer.subscription.created',
      data: {
        object: {
          id: SUBSCRIPTION,
          customer: CUSTOMER,
          status: 'active',
          current_period_end: 1_700_003_600,
        },
      },
    });
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].values).toEqual([
      'active',
      SUBSCRIPTION,
      new Date(1_700_003_600 * 1000),
      CUSTOMER,
    ]);
  });

  it('current_period_end は Basil 形（items.data[0]）からも取り出せる', async () => {
    const sql = makeFakeSql(() => [{ id: UID }]);
    await dispatchWebhookEvent(sql, {
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: SUBSCRIPTION,
          customer: CUSTOMER,
          status: 'active',
          // Stripe API 2025-03-31 (Basil) 以降は SubscriptionItem 側に載る
          items: { data: [{ current_period_end: 1_700_007_200 }] },
        },
      },
    });
    expect(sql.calls[0].values).toEqual([
      'active',
      SUBSCRIPTION,
      new Date(1_700_007_200 * 1000),
      CUSTOMER,
    ]);
  });

  it('未対応イベントは no-op（DB を叩かない）', async () => {
    const sql = makeFakeSql();
    await dispatchWebhookEvent(sql, {
      type: 'customer.updated',
      data: { object: { id: CUSTOMER } },
    });
    expect(sql.calls).toHaveLength(0);
  });

  it('展開済み customer オブジェクト（{id}）も ID 文字列に正規化', async () => {
    const sql = makeFakeSql();
    await dispatchWebhookEvent(sql, {
      type: 'invoice.payment_failed',
      data: { object: { customer: { id: CUSTOMER } } },
    });
    expect(sql.calls[0].values).toEqual([CUSTOMER]);
  });
});

describe('handleCreatePortal（Customer Portal）', () => {
  const user = { uid: UID } as AuthedUser;
  const req = new Request('http://localhost/api/billing/portal', { method: 'POST' });

  it('STRIPE_SECRET_KEY 未設定は 500（詳細はログのみ）', async () => {
    const sql = makeFakeSql();
    const res = await handleCreatePortal(req, {} as Env, sql, user);
    expect(res.status).toBe(500);
    expect(sql.calls).toHaveLength(0);
  });

  it('Customer 未紐付け（加入履歴なし）は 404 で Stripe API を呼ばない', async () => {
    const sql = makeFakeSql(() => []);
    const res = await handleCreatePortal(req, { STRIPE_SECRET_KEY: 'sk_test_x' } as Env, sql, user);
    expect(res.status).toBe(404);
    expect(sql.calls).toHaveLength(1); // customer 参照の select のみ（fetch には到達しない）
  });
});

describe('requireActiveSubscription（AI 有料ゲート）', () => {
  it('active は許可', async () => {
    const sql = makeFakeSql(() => [{ subscription_status: 'active' }]);
    const r = await requireActiveSubscription(sql, UID);
    expect(r.ok).toBe(true);
  });

  it('past_due は許可（猶予中）', async () => {
    const sql = makeFakeSql(() => [{ subscription_status: 'past_due' }]);
    const r = await requireActiveSubscription(sql, UID);
    expect(r.ok).toBe(true);
  });

  it('free は 402', async () => {
    const sql = makeFakeSql(() => [{ subscription_status: 'free' }]);
    const r = await requireActiveSubscription(sql, UID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(402);
  });

  it('canceled は 402', async () => {
    const sql = makeFakeSql(() => [{ subscription_status: 'canceled' }]);
    const r = await requireActiveSubscription(sql, UID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(402);
  });

  it('行なし（想定外）は free 扱いで 402', async () => {
    const sql = makeFakeSql(() => []);
    const r = await requireActiveSubscription(sql, UID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(402);
  });
});
