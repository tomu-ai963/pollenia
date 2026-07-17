import type { Env } from '../env';
import type { Sql } from './db';
import { errorResponse } from './error-response';
import type { AuthResult } from './auth';
import {
  STRIPE_WEBHOOK_TOLERANCE_SECONDS,
  SUBSCRIPTION_ENTITLED_STATUSES,
} from '../constants';

// Stripe 連携の低レベル部品（Phase 4）。@anthropic-ai/sdk 以外の重い依存を足さず、
// Stripe REST API を Web 標準の fetch/Web Crypto で直接叩く（Workers ランタイム互換）。
//
// セキュリティ最重要（README/AGENTS の掟に準拠、過去に とむMYSTIC で指摘された
// 脆弱な署名検証パターンを踏襲しない）:
//   * Webhook 署名検証は「タイムスタンプ許容窓」＋「タイミングセーフ比較」を必ず実装する。
//     - t（署名タイムスタンプ）が許容窓を外れたら即拒否（リプレイ防止）。
//     - HMAC-SHA256 の期待値と受信 v1 の比較は定数時間で行う（== / includes による
//       早期リターンの分岐タイミングで正解桁を漏らさない）。
//   * シークレット（STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET）はコード・toml に置かない。

export type SubscriptionStatus = 'free' | 'active' | 'past_due' | 'canceled';

const enc = new TextEncoder();

// --- サブスク状態の判定 -------------------------------------------------------

// AI 機能を許可してよいか（active / past_due）。past_due を含める理由は 0006_billing.sql と
// routes/billing.ts の invoice.payment_failed ハンドラのコメント参照（自動リトライ猶予）。
export function isEntitled(status: string | null | undefined): boolean {
  return (SUBSCRIPTION_ENTITLED_STATUSES as readonly string[]).includes(status ?? '');
}

// Stripe の subscription.status → Pollenia の subscription_status への写像。
//   active / trialing        → active（利用可）
//   past_due                 → past_due（猶予・利用可）
//   unpaid                   → past_due（Stripe 設定次第で最終リトライ後に来る。まだ猶予扱い）
//   canceled                 → canceled（解約確定・利用不可）
//   incomplete(_expired)     → free（未確定で終わった＝一度も有効化されていない）
export function mapStripeSubscriptionStatus(stripeStatus: string): SubscriptionStatus {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
      return 'canceled';
    default:
      // incomplete / incomplete_expired / paused など
      return 'free';
  }
}

// --- 認可ガード（AI 機能の有料ゲート） ---------------------------------------

// 検証済み uid のサブスク状態を引き、未加入なら 402 を返す。
// authenticateUser を通過済み（profiles 行の存在は保証済み）である前提。
export async function requireActiveSubscription(
  sql: Sql,
  uid: string,
): Promise<AuthResult<SubscriptionStatus>> {
  const rows = await sql`
    select subscription_status from pollenia.profiles where id = ${uid}::uuid
  `;
  const status = (rows[0]?.subscription_status ?? 'free') as SubscriptionStatus;
  if (!isEntitled(status)) {
    return { ok: false, response: errorResponse('PAYMENT_REQUIRED') };
  }
  return { ok: true, value: status };
}

// --- Webhook 署名検証 ---------------------------------------------------------

interface ParsedSignatureHeader {
  timestamp: number;
  v1: string[];
}

// `Stripe-Signature: t=...,v1=...,v1=...` をパースする。壊れていれば null。
export function parseStripeSignatureHeader(header: string): ParsedSignatureHeader | null {
  let timestamp: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 't') {
      // 10進整数のみ受理（0x/指数/空白混じり等の非正準表記を弾く。Opus 4.8 レビュー L4）。
      if (/^\d+$/.test(value)) timestamp = Number(value);
    } else if (key === 'v1') {
      if (value) v1.push(value);
    }
  }
  if (timestamp === null || v1.length === 0) return null;
  return { timestamp, v1 };
}

// 16進文字列同士の定数時間比較（長さが違えば false だが、一致する分は最後まで走査する）。
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Stripe Webhook 署名検証。true なら payload は改竄されておらず、許容窓内。
//   * signedPayload = `${t}.${rawBody}` の HMAC-SHA256（キー = whsec）。
//   * 許容窓: |now - t| <= toleranceSeconds（リプレイ防止）。
//   * 比較: タイミングセーフ（timingSafeEqualHex）。
// nowSeconds はテスト用の注入口（未指定は現在時刻）。
export async function verifyStripeWebhook(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  toleranceSeconds: number = STRIPE_WEBHOOK_TOLERANCE_SECONDS,
  nowSeconds?: number,
): Promise<boolean> {
  if (!signatureHeader) return false;
  const parsed = parseStripeSignatureHeader(signatureHeader);
  if (!parsed) return false;

  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestamp) > toleranceSeconds) return false;

  const expected = await hmacSha256Hex(secret, `${parsed.timestamp}.${rawBody}`);
  // 受信側の複数 v1 のいずれかが一致すればよい（Stripe のキーローテーション対応）。
  return parsed.v1.some((candidate) => timingSafeEqualHex(expected, candidate));
}

// テスト・ローカル検証用: 正しい Stripe-Signature ヘッダを生成する（本番コードでは未使用）。
export async function signStripePayload(
  rawBody: string,
  secret: string,
  timestamp: number,
): Promise<string> {
  const sig = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  return `t=${timestamp},v1=${sig}`;
}

// --- Stripe REST API 呼び出し（form-encoded） --------------------------------

const STRIPE_API_BASE = 'https://api.stripe.com/v1';

// ネストしたオブジェクトを Stripe の form ブラケット記法（a[b][c]=v）へ平坦化する。
function appendForm(params: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => appendForm(params, `${key}[${i}]`, v));
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      appendForm(params, `${key}[${k}]`, v);
    }
  } else {
    params.append(key, String(value));
  }
}

export function toStripeForm(body: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) appendForm(params, k, v);
  return params.toString();
}

export async function stripeApi<T = any>(
  secretKey: string,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${STRIPE_API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body ? toStripeForm(body) : undefined,
  });
  const data = (await res.json().catch(() => null)) as any;
  if (!res.ok) {
    // Stripe のエラーメッセージ（内部情報を含みうる）は投げてログのみに留める。
    const message = data?.error?.message ?? `Stripe API error (${res.status})`;
    throw new Error(`stripe ${method} ${path}: ${message}`);
  }
  return data as T;
}

// 既存の Customer が無ければ作成し、profiles に紐付けた上で customer id を返す。
export async function ensureStripeCustomer(
  env: Env,
  sql: Sql,
  uid: string,
): Promise<string> {
  const rows = await sql`
    select stripe_customer_id from pollenia.profiles where id = ${uid}::uuid
  `;
  const existing = rows[0]?.stripe_customer_id as string | null | undefined;
  if (existing) return existing;

  const customer = await stripeApi<{ id: string }>(env.STRIPE_SECRET_KEY!, 'POST', '/customers', {
    // uid を紐付けておくと、Webhook を customer 経由でも uid 経由でも解決できる。
    metadata: { uid },
  });

  // 競合（並行リクエストで別 customer が既に入った）に備え、未設定のときだけ入れる。
  const updated = await sql`
    update pollenia.profiles
    set stripe_customer_id = ${customer.id}
    where id = ${uid}::uuid and stripe_customer_id is null
    returning stripe_customer_id
  `;
  if (updated.length > 0) return customer.id;

  const reread = await sql`
    select stripe_customer_id from pollenia.profiles where id = ${uid}::uuid
  `;
  return (reread[0]?.stripe_customer_id as string) ?? customer.id;
}
