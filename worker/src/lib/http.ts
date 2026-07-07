// JSON / CORS レスポンスの薄いヘルパー（knowledge-rag の lib/http.ts を踏襲）。

// cross-site 構成（frontend は Cloudflare Pages、API は Workers の別オリジン）のため
// CORS を許可する。MVP ではオリジンを限定しない（本番で絞る前提）。
// 認証は Authorization: Bearer ヘッダで行うため、Allow-Headers に authorization を含める。
export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
};

// JSON レスポンス（CORS ヘッダ込み）。公開ページの Cache-Control 等は extraHeaders で足す。
export function json(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

// プリフライト(OPTIONS)応答。本文なし・204。
export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
