// JSON レスポンスの薄いヘルパー（knowledge-rag の lib/http.ts を踏襲）。
//
// 画面（frontend/ の静的配信）と API は同じ Worker・同じオリジンなので CORS ヘッダは付けない
// （旧構成の Pages + workers.dev の cross-site 用 `access-control-allow-origin: *` は廃止）。
// 認証は Cookie（workers-auth）。他オリジンのページからの読み取りはブラウザの同一オリジン
// ポリシーで止まり、状態を変えるリクエストは SDK の Origin + CSRF 二重送信検査で止まる。

// JSON レスポンス。公開ページの Cache-Control 等は extraHeaders で足す。
export function json(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  });
}
