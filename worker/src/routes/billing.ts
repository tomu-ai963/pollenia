import type { Env } from '../env';
import type { Sql } from '../lib/db';
import { json } from '../lib/http';
import { errorResponse } from '../lib/error-response';
import type { AuthedUser } from '../lib/auth';
import {
  ensureStripeCustomer,
  mapStripeSubscriptionStatus,
  stripeApi,
  verifyStripeWebhook,
} from '../lib/stripe';
import { STRIPE_WEBHOOK_TOLERANCE_SECONDS } from '../constants';

// 課金エンドポイント（Phase 4）。
//   - POST /api/billing/checkout  … Checkout Session を作成しリダイレクト URL を返す（JWT + profiles 行が必要）
//   - POST /api/billing/portal    … Customer Portal Session（解約・支払い方法変更）を作成（同上）
//   - POST /api/billing/webhook   … Stripe からの Webhook 受信（認証不要。署名で真正性を担保）
//
// サブスク状態は pollenia.profiles で一元管理し、AI 機能（/api/ai/*）の有料ゲートに使う。

// ローカル検証用のフォールバック（本番は STRIPE_SUCCESS_URL / STRIPE_CANCEL_URL /
// STRIPE_PORTAL_RETURN_URL を設定）。
const DEFAULT_SUCCESS_URL = 'http://127.0.0.1:8788/?checkout=success';
const DEFAULT_CANCEL_URL = 'http://127.0.0.1:8788/?checkout=cancel';
const DEFAULT_PORTAL_RETURN_URL = 'http://127.0.0.1:8788/';

// POST /api/billing/checkout — Stripe Checkout Session（subscription モード）を作成。
// Request : ボディ不要。Response: { url }（フロントはこの URL へリダイレクト）。
export async function handleCreateCheckout(
  req: Request,
  env: Env,
  sql: Sql,
  user: AuthedUser,
): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PRICE_ID) {
    return errorResponse('INTERNAL_ERROR', {
      detail: 'STRIPE_SECRET_KEY / STRIPE_PRICE_ID is not configured',
    });
  }

  try {
    const customerId = await ensureStripeCustomer(env, sql, user.uid);

    const session = await stripeApi<{ id: string; url: string | null }>(
      env.STRIPE_SECRET_KEY,
      'POST',
      '/checkout/sessions',
      {
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
        success_url: env.STRIPE_SUCCESS_URL ?? DEFAULT_SUCCESS_URL,
        cancel_url: env.STRIPE_CANCEL_URL ?? DEFAULT_CANCEL_URL,
        // uid を複数経路で埋め込む（Webhook が client_reference_id / metadata / subscription metadata の
        // いずれでもユーザーを解決できるようにする）。
        client_reference_id: user.uid,
        metadata: { uid: user.uid },
        subscription_data: { metadata: { uid: user.uid } },
      },
    );

    if (!session.url) {
      return errorResponse('INTERNAL_ERROR', { detail: 'Stripe returned no checkout url' });
    }
    return json({ url: session.url });
  } catch (e) {
    return errorResponse('INTERNAL_ERROR', { detail: e });
  }
}

// POST /api/billing/portal — Stripe Customer Portal Session を作成。
// 解約・支払い方法変更をユーザー自身が Stripe ホストのページで行えるようにする。
// Request : ボディ不要。Response: { url }（フロントはこの URL へリダイレクト）。
export async function handleCreatePortal(
  req: Request,
  env: Env,
  sql: Sql,
  user: AuthedUser,
): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY) {
    return errorResponse('INTERNAL_ERROR', { detail: 'STRIPE_SECRET_KEY is not configured' });
  }

  try {
    // Portal は既存 Customer が前提（Checkout と違いここでは作成しない。
    // 一度も加入手続きをしていないユーザーに Portal を開かせても何も管理できないため）。
    const rows = await sql`
      select stripe_customer_id from pollenia.profiles where id = ${user.uid}::uuid
    `;
    const customerId = rows[0]?.stripe_customer_id as string | null | undefined;
    if (!customerId) {
      return errorResponse('NOT_FOUND', {
        publicMessage: '有料プランの加入履歴がありません。',
      });
    }

    const session = await stripeApi<{ url: string | null }>(
      env.STRIPE_SECRET_KEY,
      'POST',
      '/billing_portal/sessions',
      {
        customer: customerId,
        return_url: env.STRIPE_PORTAL_RETURN_URL ?? DEFAULT_PORTAL_RETURN_URL,
      },
    );

    if (!session.url) {
      return errorResponse('INTERNAL_ERROR', { detail: 'Stripe returned no portal url' });
    }
    return json({ url: session.url });
  } catch (e) {
    return errorResponse('INTERNAL_ERROR', { detail: e });
  }
}

// POST /api/billing/webhook — Stripe Webhook。
// 署名検証（タイムスタンプ許容窓 + タイミングセーフ比較）を通ったものだけ処理する。
// 検証失敗は 400（詳細はログのみ）。処理は 5 イベントを網羅する。
export async function handleStripeWebhook(req: Request, env: Env, sql: Sql): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return errorResponse('INTERNAL_ERROR', { detail: 'STRIPE_WEBHOOK_SECRET is not configured' });
  }

  // 署名検証には生のボディ文字列が必要（JSON.parse する前に読む）。
  const rawBody = await req.text();
  const signature = req.headers.get('stripe-signature');

  const valid = await verifyStripeWebhook(
    rawBody,
    signature,
    env.STRIPE_WEBHOOK_SECRET,
    STRIPE_WEBHOOK_TOLERANCE_SECONDS,
  );
  if (!valid) {
    return errorResponse('VALIDATION_ERROR', {
      detail: 'stripe webhook signature verification failed',
      publicMessage: '署名の検証に失敗しました。',
    });
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return errorResponse('VALIDATION_ERROR', { detail: e });
  }

  try {
    await dispatchWebhookEvent(sql, event);
  } catch (e) {
    // ハンドラ内の DB エラー等。Stripe には 500 を返すと再送される。
    return errorResponse('INTERNAL_ERROR', { detail: e });
  }

  // Stripe は 2xx を「受領」とみなす。未対応イベントも 200 で受ける（購読していなくても安全）。
  return json({ received: true });
}

// イベント種別ごとのディスパッチ（テストから直接呼べるよう分離）。
export async function dispatchWebhookEvent(sql: Sql, event: any): Promise<void> {
  const object = event?.data?.object ?? {};
  switch (event?.type) {
    case 'checkout.session.completed':
      await onCheckoutCompleted(sql, object);
      break;
    // .created も .updated と同じ写像で処理する。初回契約（Checkout 完了）では
    // .updated が飛ばないことがあり、current_period_end（次回更新日時）を確実に
    // 取り込むには subscription 本体を運ぶ .created の購読が必要。
    // 順序前後で古い .created が後着しても、写像は絶対値の上書きであり
    // .updated の後着と同じ既知の挙動に収まる（新しいリスク類型は増えない）。
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await onSubscriptionUpdated(sql, object);
      break;
    case 'customer.subscription.deleted':
      await onSubscriptionDeleted(sql, object);
      break;
    case 'invoice.paid':
      await onInvoicePaid(sql, object);
      break;
    case 'invoice.payment_failed':
      await onInvoicePaymentFailed(sql, object);
      break;
    default:
      // 未購読・未対応イベントは無視（no-op）。
      break;
  }
}

// --- 各イベントハンドラ -------------------------------------------------------

// 初回契約。customer / subscription を profiles に紐付け、active にする。
// uid は client_reference_id（無ければ metadata.uid）で解決する（最も確実）。
async function onCheckoutCompleted(sql: Sql, session: any): Promise<void> {
  // subscription モードかつ支払い完了のみを active 化する（Opus 4.8 レビュー M2）。
  // 非同期決済で未確定（payment_status='unpaid'）のまま、あるいは将来 one-time 決済用の
  // セッションを取り違えて有料機能を開放しないためのガード。未確定でも紐付けは行わず、
  // 確定後の customer.subscription.updated（status 写像）で active 化・紐付けする。
  // モックに mode/payment_status が無い場合は従来どおり通す（`&&` の左でスキップ）。
  if (session.mode && session.mode !== 'subscription') return;
  const paymentStatus = session.payment_status;
  if (paymentStatus && paymentStatus !== 'paid' && paymentStatus !== 'no_payment_required') return;

  const uid: string | undefined = session.client_reference_id ?? session.metadata?.uid;
  if (!uid) return;
  const customerId = asId(session.customer);
  const subscriptionId = asId(session.subscription);
  // session.subscription が展開済みオブジェクトなら期間終了も拾える（通常は ID 文字列で null。
  // その場合は customer.subscription.created/updated 側で同期されるので coalesce で温存）。
  const periodEnd =
    session.subscription && typeof session.subscription === 'object'
      ? subscriptionPeriodEnd(session.subscription)
      : null;

  await sql`
    update pollenia.profiles set
      subscription_status = 'active',
      stripe_customer_id = ${customerId},
      stripe_subscription_id = ${subscriptionId},
      current_period_end = coalesce(${periodEnd}, current_period_end)
    where id = ${uid}::uuid
  `;
}

// プラン変更・更新時の status 同期。Stripe status を写像して反映する。
// 対象は stripe_customer_id で特定。未紐付け（checkout.completed が先に来ていない）の
// 取りこぼしに備え、metadata.uid でフォールバックし、その際に customer id も埋める。
async function onSubscriptionUpdated(sql: Sql, subscription: any): Promise<void> {
  const status = mapStripeSubscriptionStatus(subscription.status);
  const customerId = asId(subscription.customer);
  const subscriptionId = asId(subscription.id);
  const periodEnd = subscriptionPeriodEnd(subscription);
  const uid: string | undefined = subscription.metadata?.uid;

  if (customerId) {
    const rows = await sql`
      update pollenia.profiles set
        subscription_status = ${status},
        stripe_subscription_id = ${subscriptionId},
        current_period_end = ${periodEnd}
      where stripe_customer_id = ${customerId}
      returning id
    `;
    if (rows.length > 0) return;
  }
  if (uid) {
    await sql`
      update pollenia.profiles set
        subscription_status = ${status},
        stripe_subscription_id = ${subscriptionId},
        current_period_end = ${periodEnd},
        stripe_customer_id = coalesce(stripe_customer_id, ${customerId})
      where id = ${uid}::uuid
    `;
  }
}

// 解約（サブスク削除）。status を free に戻し、subscription id を外す。customer 紐付けは残す。
async function onSubscriptionDeleted(sql: Sql, subscription: any): Promise<void> {
  const customerId = asId(subscription.customer);
  const uid: string | undefined = subscription.metadata?.uid;

  if (customerId) {
    const rows = await sql`
      update pollenia.profiles set
        subscription_status = 'free',
        stripe_subscription_id = null,
        current_period_end = null
      where stripe_customer_id = ${customerId}
      returning id
    `;
    if (rows.length > 0) return;
  }
  if (uid) {
    await sql`
      update pollenia.profiles set
        subscription_status = 'free',
        stripe_subscription_id = null,
        current_period_end = null
      where id = ${uid}::uuid
    `;
  }
}

// 継続課金成功。active を維持（past_due からの復帰もここで active に戻る）。
// Opus 4.8 レビュー M1: Stripe はイベント配送順を保証しないため、解約確定後（free/canceled）に
// 順序前後・滞留した古い invoice.paid が届いても復活させないよう、対象を「既に有料相当
// （active/past_due）」に限定する。正規の（再）加入は checkout.session.completed / customer.
// subscription.updated(active) 経由で行われる。
async function onInvoicePaid(sql: Sql, invoice: any): Promise<void> {
  const customerId = asId(invoice.customer);
  if (!customerId) return;
  await sql`
    update pollenia.profiles set subscription_status = 'active'
    where stripe_customer_id = ${customerId}
      and subscription_status in ('active', 'past_due')
  `;
}

// 支払い失敗。past_due にする（＝ AI 機能は許可し続ける＝即時停止しない）。
//
// 設計理由（猶予期間の扱い）:
//   Stripe は支払い失敗後に自動リトライ（Smart Retries / 手動リトライ設定に従う。既定で数日〜約2週間）
//   を行う。この間に成功すれば invoice.paid が飛んで active へ復帰する。よって past_due の間も
//   機能を止めず猶予を与えるのが妥当。リトライを打ち切ると Stripe は Subscription を
//   canceled（→ customer.subscription.deleted → free）または unpaid（→ .updated → past_due 維持後、
//   運用上は解約導線へ）にするため、「猶予の長さ」は Stripe 側の dunning 設定に委譲する形になる。
//   Worker 側に固定日数を持たせない（Stripe の設定と二重管理になり齟齬の元になる）ことを選択した。
async function onInvoicePaymentFailed(sql: Sql, invoice: any): Promise<void> {
  const customerId = asId(invoice.customer);
  if (!customerId) return;
  await sql`
    update pollenia.profiles set subscription_status = 'past_due'
    where stripe_customer_id = ${customerId}
  `;
}

// subscription の現在期間終了（次回更新日時）を取り出す。
// Stripe API 2025-03-31（Basil）以降、current_period_end は Subscription 本体から
// SubscriptionItem へ移動したため、両方の形を受ける（アカウントの API バージョンに依存しない）。
function subscriptionPeriodEnd(subscription: any): Date | null {
  const epoch =
    typeof subscription?.current_period_end === 'number'
      ? subscription.current_period_end
      : subscription?.items?.data?.[0]?.current_period_end;
  return typeof epoch === 'number' ? new Date(epoch * 1000) : null;
}

// Stripe のフィールドは文字列 ID か、展開済みオブジェクト（{id}）のことがある。ID 文字列に正規化。
function asId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as any).id === 'string') {
    return (value as any).id;
  }
  return null;
}
