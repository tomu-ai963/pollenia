import type { Sql } from '../db';
import { AI_RATE_LIMIT_PER_DAY, AI_RATE_LIMIT_PER_MINUTE } from '../../constants';

// AI 呼び出しのレート制限（同一ユーザーの連投防止・コストの青天井防止）。
// KV 等の外部ストアは使わず、pollenia.ai_usage_events の count で判定する
// （呼び出し頻度が低い前提の素朴な実装。スケール時は Cloudflare Rate Limiting へ移行）。
//
// TOCTOU 対策（Opus 4.8 レビュー M1）: 「count → 判定 → insert」の順だと並行リクエストが
// 全員同じ count を読んで上限をすり抜ける。そこで 1 トランザクション内で
//   ユーザー単位の advisory lock → insert → count（自分の分を含む）
// の順に直列化し、判定は「自分を含めた件数が上限を超えたか」で行う。
// 上限超過の試行もイベントとして残る（失敗リトライの連打がそのまま throttle を伸ばす側に働く）。

export interface AiUsageCounts {
  // いずれも「今回の試行を含む」件数。
  minute: number;
  day: number;
}

// 純粋な判定関数（vitest 対象）。counts は今回の試行を含むため、境界は「超えたら」拒否
// （= perMinute 件目までは許可）。
export function isAiRateLimited(
  counts: AiUsageCounts,
  limits = { perMinute: AI_RATE_LIMIT_PER_MINUTE, perDay: AI_RATE_LIMIT_PER_DAY },
): boolean {
  return counts.minute > limits.perMinute || counts.day > limits.perDay;
}

// 利用イベントを1件記録し、直近ウィンドウの件数（自分を含む）を返す。
// advisory lock は xact スコープ（トランザクション終了で自動解放）。キーはユーザー毎に
// 名前空間付きでハッシュし、共有DB上の他プロジェクトのロックと衝突させない。
export async function consumeAiUsage(
  sql: Sql,
  uid: string,
  kind: 'consult' | 'listing',
): Promise<AiUsageCounts> {
  const rows = await sql.begin(async (trx) => {
    await trx`select pg_advisory_xact_lock(hashtextextended('pollenia_ai:' || ${uid}::text, 0))`;
    await trx`
      insert into pollenia.ai_usage_events (user_id, kind)
      values (${uid}::uuid, ${kind})
    `;
    return await trx`
      select
        count(*) filter (where created_at > now() - interval '1 minute') as minute_count,
        count(*) as day_count
      from pollenia.ai_usage_events
      where user_id = ${uid}::uuid and created_at > now() - interval '24 hours'
    `;
  });
  const row = (rows as unknown as { minute_count: unknown; day_count: unknown }[])[0];
  return { minute: Number(row.minute_count), day: Number(row.day_count) };
}
