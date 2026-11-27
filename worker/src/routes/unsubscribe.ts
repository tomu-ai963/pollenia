import type { Env } from '../env';
import type { Sql } from '../lib/db';
import { isUuid } from '../lib/validate';
import { verifyUnsubscribe } from '../lib/digest';

// /public/unsubscribe?u=<uid>&t=<署名> — 「次の作業」の週1メールの配信停止（ログイン不要）。
// - GET: 確認ページ（ボタンで POST）。メールのリンクを先読みするセキュリティ製品が GET を踏んでも止まらない
// - POST: 署名を確かめて task_digest = false にする。メールソフトのワンクリック配信停止（RFC 8058）もここに来る
// 署名が合わなければ、何もせず同じ「確認できませんでした」を返す（uid が存在するかは見せない）。
// ページは Worker が返す固定の HTML（利用者の入力は埋め込まない）。

const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function page(title: string, body: string, status = 200): Response {
  const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${title} — Pollenia</title>
<style>body{font-family:sans-serif;background:#fdf8ec;color:#4a4230;max-width:520px;margin:48px auto;padding:0 16px}
.card{background:#fff;border-radius:16px;padding:24px}button{padding:10px 20px;border-radius:999px;border:0;background:#dff2ea;color:#4fa588;font-weight:600;font-size:1rem;cursor:pointer}a{color:#4fa588}</style>
</head><body><div class="card"><h1 style="font-size:1.2rem">${title}</h1>${body}</div></body></html>`;
  return new Response(html, { status, headers: HEADERS });
}

const INVALID = () =>
  page(
    'リンクを確認できませんでした',
    '<p>メールのリンクが途中で切れていないか確かめてください。ログインして、記録タブの「次の作業」からも止められます。</p><p><a href="/">Pollenia を開く</a></p>',
    400,
  );

async function verified(env: Env, url: URL): Promise<string | null> {
  const uid = url.searchParams.get('u') ?? '';
  const token = url.searchParams.get('t') ?? '';
  if (!isUuid(uid) || !token) return null;
  return (await verifyUnsubscribe(env, uid, token)) ? uid : null;
}

export async function handleUnsubscribe(req: Request, env: Env, sql: Sql): Promise<Response> {
  const url = new URL(req.url);
  const uid = await verified(env, url);
  if (!uid) return INVALID();

  if (req.method === 'GET') {
    // フォームの送信先は同じ URL（u と t をそのまま使う）。action は書かない＝今の URL に POST
    return page(
      '週1メールの配信を止めますか？',
      '<p>「次の作業」のお知らせメールを止めます。記録はそのまま残ります。</p><form method="post"><button type="submit">配信を止める</button></form>',
    );
  }
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });

  await sql`update pollenia.profiles set task_digest = false where id = ${uid}::uuid`;
  return page(
    '配信を止めました',
    '<p>「次の作業」のお知らせメールは届かなくなります。また受け取るときは、ログインして記録タブの「次の作業」から選んでください。</p><p><a href="/">Pollenia を開く</a></p>',
  );
}
