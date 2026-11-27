import type { Env } from './env';
import { createDb, type Sql } from './lib/db';
import { createDigestMailer, type DigestMailer } from './lib/mail';
import { digestMessage, selectDueTasks, todayJst, unsubscribeUrl } from './lib/digest';
import { loadTasksFor } from './routes/tasks';
import { APP_ORIGIN_DEFAULT, DIGEST_MAX_PER_RUN } from './constants';

// 「次の作業」の週1メール（wrangler.toml の [triggers] crons。毎週月曜 8:00 JST）。
//
// - 対象は task_digest = true の人のうち、今日（JST）まだ処理していない人（cron の再実行で二重に送らない）
// - 期日が 7 日以内（過ぎたものを含む）の作業が無ければ送らない（処理済みの印だけ付ける）
// - 1 人の失敗で全体を止めない。ログには件数とステータスだけ出す（宛先・本文は出さない）

export interface DigestResult {
  checked: number;
  sent: number;
  skipped: number;
  failed: number;
}

export async function runTaskDigest(
  env: Env,
  sql: Sql,
  mailer: DigestMailer,
  now: Date = new Date(),
): Promise<DigestResult> {
  const today = todayJst(now);
  const origin = env.APP_ORIGIN?.trim() || APP_ORIGIN_DEFAULT;
  const users = await sql`
    select p.id, p.display_name, u.email
    from pollenia.profiles p
    join pollenia.users u on u.id = p.id
    where p.task_digest
      and (p.task_digest_last_sent_on is null or p.task_digest_last_sent_on < ${today}::date)
    order by p.id
    limit ${DIGEST_MAX_PER_RUN}
  `;

  const result: DigestResult = { checked: users.length, sent: 0, skipped: 0, failed: 0 };
  for (const u of users) {
    const uid = u.id as string;
    try {
      const due = selectDueTasks(await loadTasksFor(sql, uid), today);
      if (due.length > 0) {
        const unsub = await unsubscribeUrl(env, origin, uid);
        const message = digestMessage(u.display_name as string, due, today, { app: `${origin}/`, unsubscribe: unsub });
        await mailer.send(u.email as string, message, unsub);
        result.sent++;
      } else {
        result.skipped++;
      }
      await sql`
        update pollenia.profiles set task_digest_last_sent_on = ${today}::date
        where id = ${uid}::uuid
      `;
    } catch (err) {
      // 次の実行で送り直せるよう、処理済みの印は付けない
      result.failed++;
      console.error('task digest failed', err instanceof Error ? err.name : 'unknown');
    }
  }
  return result;
}

export async function handleScheduled(env: Env, ctx: ExecutionContext): Promise<void> {
  const mailer = createDigestMailer(env);
  if (!mailer) {
    console.error('task digest skipped: メール送信の設定がありません（RESEND_API_KEY と MAIL_FROM）');
    return;
  }
  const sql = createDb(env);
  try {
    const r = await runTaskDigest(env, sql, mailer);
    console.log(`task digest: checked=${r.checked} sent=${r.sent} skipped=${r.skipped} failed=${r.failed}`);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}
