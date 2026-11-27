import { errorResponse } from './error-response';

// 利用者ごとの回数制限（Workers の Rate Limiting バインディング。wrangler.toml の [[ratelimits]]）。
// 書き込みの多い操作（CSV 取り込み・交換の投稿・写真の追加）を、検証済み uid ごとに数える。
// ダッシュボードの Rate Limiting（IP ごと）とは別。こちらは同じ利用者が IP を変えても数えられる。
//
// fail-closed: バインディングが無い（設定漏れ）・limit() が失敗したときは通さない（503）。
// 数えられないまま通すと、制限が黙って無効になるため（AI のレート制限 lib/ai/rate-limit.ts と同じ方針）。
// 数え方は Cloudflare の拠点ごとの近似（ドキュメントの Accuracy）。厳密な上限ではなく、連打・自動化の歯止め。

export async function limitPerUser(binding: RateLimit | undefined, uid: string): Promise<Response | null> {
  if (!binding) {
    console.error('rate limit binding is missing');
    return errorResponse('SERVICE_UNAVAILABLE', { detail: 'rate limit binding is missing' });
  }
  try {
    const { success } = await binding.limit({ key: uid });
    return success ? null : errorResponse('RATE_LIMITED');
  } catch (err) {
    console.error('rate limit failed', err instanceof Error ? err.name : 'unknown');
    return errorResponse('SERVICE_UNAVAILABLE', { detail: 'rate limit failed' });
  }
}
