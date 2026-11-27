import type { Env } from '../env';
import type { Task } from './tasks';

// 「次の作業」の週1メール（0006_task_digest.sql・scheduled.ts）。
//
// - 載せるのは期日が 7 日以内（過ぎたものを含む）の作業だけ。期日の無い作業は載せない
//   （毎週同じものが並ぶと読まれなくなる）
// - 配信停止リンクは uid への HMAC 署名付き（ログイン不要）。鍵は DEVICE_AUTH_SECRET から
//   HKDF で派生させる（info で用途を分け、ログイン・写真 URL の鍵と混ぜない。lib/photos.ts と同じやり方）
// - 本文は利用者本人の記録（個体名）だけ。宛先・本文はログに出さない

export const DIGEST_WINDOW_DAYS = 7;
const HKDF_INFO = 'pollenia task digest unsubscribe v1';
const enc = new TextEncoder();

/** 日本時間の今日（YYYY-MM-DD）。cron は UTC で動くので +9 時間してから日付を取る */
export function todayJst(now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** メールに載せる作業: 期日が今日から DIGEST_WINDOW_DAYS 日以内か、過ぎたもの（期日の早い順のまま） */
export function selectDueTasks(tasks: readonly Task[], today: string): Task[] {
  return tasks.filter((t) => t.due_date && daysBetween(today, t.due_date) <= DIGEST_WINDOW_DAYS);
}

const KIND_LABEL: Record<Task['kind'], string> = { harvest: '採種', sow: '播種', germination: '発芽の確認' };

function taskLine(t: Task, today: string): string {
  const seed = t.seed_parent_name ?? '?';
  const pair =
    t.pollen_parent_id && t.pollen_parent_id === t.seed_parent_id
      ? `${seed}（自家受粉）`
      : `${seed} × ${t.pollen_parent_name ?? '父不明'}`;
  const d = daysBetween(today, t.due_date!);
  const when = d < 0 ? `${-d}日過ぎ` : d === 0 ? '今日' : `あと${d}日`;
  return `・${KIND_LABEL[t.kind]}: ${pair}　期日 ${t.due_date}（${when}）`;
}

export function digestMessage(
  displayName: string,
  tasks: readonly Task[],
  today: string,
  links: { app: string; unsubscribe: string },
): { subject: string; text: string } {
  const overdue = tasks.filter((t) => daysBetween(today, t.due_date!) < 0).length;
  return {
    subject: overdue
      ? `Pollenia: 期日を過ぎた作業が ${overdue} 件あります`
      : `Pollenia: 今週の作業が ${tasks.length} 件あります`,
    text: [
      `${displayName} さん`,
      '',
      `期日が ${DIGEST_WINDOW_DAYS} 日以内の作業です（${today} 時点）。`,
      '',
      ...tasks.slice(0, 30).map((t) => taskLine(t, today)),
      ...(tasks.length > 30 ? [`ほか ${tasks.length - 30} 件`] : []),
      '',
      `記録する: ${links.app}`,
      '',
      '――',
      'このメールは、Pollenia で「次の作業をメールで受け取る」を選んだ方に毎週月曜に送っています。',
      `配信を止める: ${links.unsubscribe}`,
    ].join('\n'),
  };
}

// ---- 配信停止リンクの署名 ----------------------------------------------------

async function deriveKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(HKDF_INFO) },
    base,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function b64url(bytes: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function secretOf(env: Env): string {
  const s = env.DEVICE_AUTH_SECRET?.trim();
  if (!s) throw new Error('DEVICE_AUTH_SECRET が設定されていません');
  return s;
}

export async function signUnsubscribe(env: Env, uid: string): Promise<string> {
  const key = await deriveKey(secretOf(env));
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(`unsubscribe:${uid}`)));
}

/** 署名の検証（crypto.subtle.verify は一定時間で比べる） */
export async function verifyUnsubscribe(env: Env, uid: string, token: string): Promise<boolean> {
  const sig = fromB64url(token);
  if (!sig) return false;
  const key = await deriveKey(secretOf(env));
  return crypto.subtle.verify('HMAC', key, sig, enc.encode(`unsubscribe:${uid}`));
}

export async function unsubscribeUrl(env: Env, origin: string, uid: string): Promise<string> {
  const url = new URL('/public/unsubscribe', origin);
  url.searchParams.set('u', uid);
  url.searchParams.set('t', await signUnsubscribe(env, uid));
  return url.toString();
}
