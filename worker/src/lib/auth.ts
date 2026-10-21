import { type Auth, type AuthEvent, type AuthUser, createAuth } from '@tomu-ai/workers-auth';
import { type DeviceAuth, deviceAuth, deviceBoundSessionStore } from '@tomu-ai/workers-auth/device-auth';
import {
  type PgExecutor,
  type PgQueryResult,
  type PgRow,
  pgDeviceAuthStore,
  pgSessionStore,
} from '@tomu-ai/workers-auth/store/pg';
import type { Env } from '../env';
import type { Sql } from './db';
import { errorResponse } from './error-response';
import { createMailer } from './mail';

// ログイン: workers-auth v0.3.1 の deviceAuth（PIN + 信頼済み端末 + メールコード）。
//
//   新しい端末:   メール → 6 桁コード → セッション + 端末を信頼済みに登録 → （未設定なら）PIN 設定
//   信頼済み端末: PIN だけ。3 回続けて間違えると、メールコードが通るまで PIN ログインは止まる
//
// 画面と API は同じオリジン（1つの Worker）なので transport は 'cookie'。セッション・CSRF・端末の
// Cookie はすべて __Host- 付き・Secure・HttpOnly（CSRF 以外）。状態は Neon（auth_* テーブル）に置く。
//
// 登録は誰でもできる（2026-10-22 とむ決定）。メールコードを通ったアドレスは resolveUser が
// pollenia.users に find-or-create する。送信量の歯止めは deviceAuth 組み込みのレート制限
// （アドレス単位の再送間隔・1時間あたりの通数、IP 単位の開始・検証回数）。
//
// 重要（旧「掟」5 の後継）: 有効なセッション ≠ Pollenia ユーザー。メールコードを通っただけで
// 表示名を登録していない users 行がありうる。必ず pollenia.profiles 行で判定する（authenticateUser）。

export interface AuthedUser {
  uid: string;
  displayName: string;
}

export type AuthResult<T> = { ok: true; value: T } | { ok: false; response: Response };

// セッションの有効期限。信頼済み端末なら PIN だけで取り直せるので短めにする（personal-rag と同じ）。
export const SESSION_IDLE_TTL_SEC = 24 * 60 * 60;
export const SESSION_ABSOLUTE_TTL_SEC = 7 * 24 * 60 * 60;

export const DEFAULT_PIN_ITERATIONS = 100_000;

// SDK の既定と同じ正規化（trim + 小文字）。pollenia.users.email の CHECK と揃える。
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function parseIterations(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return DEFAULT_PIN_ITERATIONS;
  return Math.min(Math.max(n, 1_000), 100_000);
}

function counted(result: { count: number | null } & ArrayLike<PgRow>): PgQueryResult {
  // rowCount を「不明 → 0」と読み替えない（SDK の要件。README「Postgres stores」）
  if (typeof result.count !== 'number') throw new Error('postgres.js: no row count in the result');
  return { rows: Array.from(result), rowCount: result.count };
}

// workers-auth の pg ストア用 executor（postgres.js 版）。リクエストごとの接続（lib/db.ts の
// max: 1）をそのまま使う。query は 1 文ずつ autocommit、transaction は sql.begin の中で順に流す。
// prepare: false（db.ts）なので Hyperdrive / pooler 越しでも named prepared statement は作らない。
export function postgresExecutor(sql: Sql): PgExecutor {
  return {
    query: async <R extends PgRow>(text: string, params: readonly unknown[]) =>
      counted(await sql.unsafe(text, params as never[])) as PgQueryResult<R>,
    transaction: async (statements) =>
      sql.begin(async (tx) => {
        const results: PgQueryResult[] = [];
        for (const s of statements) results.push(counted(await tx.unsafe(s.text, s.params as never[])));
        return results;
      }) as Promise<PgQueryResult[]>,
  };
}

// メールコードを通ったアドレスを Pollenia のユーザー ID（pollenia.users.id）に解決する。
// 初めてのアドレスなら作る。on conflict do update は「既存行も returning で返す」ための no-op 更新。
export async function findOrCreateUser(sql: Sql, email: string): Promise<AuthUser> {
  const rows = await sql`
    insert into pollenia.users (email) values (${email})
    on conflict (email) do update set email = excluded.email
    returning id
  `;
  const id = rows[0].id as string;
  return { id, subjectType: 'user', rateLimitId: id, email, claims: { email } };
}

// 監査イベントのうち、ログに残す種類（アドレス・ユーザー ID は出さない）。
function logEvent(event: AuthEvent): void {
  const { type } = event;
  const reason = 'reason' in event ? event.reason : 'scope' in event ? event.scope : undefined;
  if (/failed|locked|rate_limited|revoked|csrf|bot_check|circuit/.test(type)) {
    console.warn(`auth event: ${type}${reason ? ` (${String(reason)})` : ''}`);
  }
}

export interface AuthContext {
  auth: Auth;
  device: DeviceAuth;
}

// 設定不足（シークレット・メール送信）のときに投げる。index.ts が 503 にする。
// どのアドレスに対しても同じ応答なので、列挙の手掛かりにならない。
export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

// リクエストごとに組み立てる（バインディングと DB 接続はリクエストの中にしか無いため）。
export function buildAuth(env: Env, sql: Sql, requestUrl: string): AuthContext {
  const secret = env.DEVICE_AUTH_SECRET?.trim();
  if (!secret) throw new AuthConfigError('DEVICE_AUTH_SECRET が設定されていません');
  const mailer = createMailer(env, requestUrl);
  if (!mailer) throw new AuthConfigError('メール送信の設定がありません（RESEND_API_KEY と MAIL_FROM）');

  const executor = postgresExecutor(sql);
  const devices = pgDeviceAuthStore(executor);
  const sessions = deviceBoundSessionStore(pgSessionStore(executor), devices);

  const auth = createAuth({
    providers: [],
    store: sessions,
    // __Host- / Secure / HttpOnly は SDK の既定。画面と API は同一オリジンなので Strict にする
    // （Stripe Checkout からの戻りはトップレベル遷移で、戻った後の API 呼び出しは同一サイト）
    cookie: { sameSite: 'Strict' },
    session: { idleTtlSec: SESSION_IDLE_TTL_SEC, absoluteTtlSec: SESSION_ABSOLUTE_TTL_SEC },
    onEvent: logEvent,
  });

  let device: DeviceAuth;
  try {
    device = deviceAuth({
      auth,
      store: devices,
      transport: 'cookie',
      secret,
      previousSecrets: env.DEVICE_AUTH_PREVIOUS_SECRETS?.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      normalizeEmail,
      resolveUser: (email) => findOrCreateUser(sql, email),
      sendCode: (email, code) => mailer.sendLoginCode(email, code),
      // 送信の失敗はレスポンスに出さない。ログには種類と status だけ（宛先・コードは出さない）
      onSendError: (error) => {
        const status = (error as { status?: unknown } | null)?.status;
        console.error(
          `login code send failed: ${error instanceof Error ? error.name : 'unknown'} ${status ?? ''}`,
        );
      },
      pin: {
        iterations: parseIterations(env.PIN_PBKDF2_ITERATIONS),
        // PIN を変えたら、ほかの信頼済み端末とアカウントの全セッションを失効させる（端末を盗まれた後の
        // 立て直し）。変更した端末も一度ログアウトされ、新しい PIN で入り直す
        revokeOtherDevicesOnChange: true,
      },
    });
  } catch (err) {
    // 弱い DEVICE_AUTH_SECRET など。値は出さない
    throw new AuthConfigError(
      `deviceAuth の設定が不正です: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { auth, device };
}

// セッションの user.id（= pollenia.users.id）を Pollenia ユーザーへ解決する。
// profiles 行が無ければ 403（POST /api/profiles で登録してもらう）。
export async function authenticateUser(sql: Sql, uid: string): Promise<AuthResult<AuthedUser>> {
  const rows = await sql`
    select id, display_name from pollenia.profiles where id = ${uid}::uuid
  `;
  if (rows.length === 0) {
    return {
      ok: false,
      response: errorResponse('FORBIDDEN', {
        publicMessage: 'Pollenia のユーザー登録が必要です（POST /api/profiles）。',
      }),
    };
  }
  return { ok: true, value: { uid: rows[0].id, displayName: rows[0].display_name } };
}
