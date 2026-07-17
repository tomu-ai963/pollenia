import type { Sql } from '../db';
import {
  AI_RATE_LIMIT_PER_DAY,
  AI_RATE_LIMIT_PER_MINUTE,
  AI_RATE_LIMIT_PER_MONTH,
} from '../../constants';

// AI 呼び出しのレート制限（同一ユーザーの連投防止・コストの青天井防止）。
// KV 等の外部ストアは使わず、pollenia.ai_usage_events の count で判定する
// （呼び出し頻度が低い前提の素朴な実装。スケール時は Cloudflare Rate Limiting へ移行）。
//
// 有料プラン（Phase 4）の主軸は「月70回を目安」の月次上限。分/日は瞬間的な連打・
// 単日暴発のガードとして残す。上限に達した種別は aiRateLimitReason で判別し、
// UI へ具体的な文言（月間/本日/短時間）を返す。
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
  month: number;
}

export interface AiRateLimits {
  perMinute: number;
  perDay: number;
  perMonth: number;
}

const DEFAULT_LIMITS: AiRateLimits = {
  perMinute: AI_RATE_LIMIT_PER_MINUTE,
  perDay: AI_RATE_LIMIT_PER_DAY,
  perMonth: AI_RATE_LIMIT_PER_MONTH,
};

// 純粋な判定関数（vitest 対象）。counts は今回の試行を含むため、境界は「超えたら」拒否
// （= 上限件目までは許可）。
export function isAiRateLimited(counts: AiUsageCounts, limits: AiRateLimits = DEFAULT_LIMITS): boolean {
  return aiRateLimitReason(counts, limits) !== null;
}

// 上限超過の種別を返す（UI 文言の出し分け用）。優先度は 月 > 日 > 分
// （最も「重い」＝復帰に時間がかかる制限を優先して案内する）。超過なしは null。
export function aiRateLimitReason(
  counts: AiUsageCounts,
  limits: AiRateLimits = DEFAULT_LIMITS,
): 'month' | 'day' | 'minute' | null {
  if (counts.month > limits.perMonth) return 'month';
  if (counts.day > limits.perDay) return 'day';
  if (counts.minute > limits.perMinute) return 'minute';
  return null;
}

// レート制限理由に対応するユーザー向け文言（クライアントに返す安全な固定文）。
export function aiRateLimitMessage(
  reason: 'month' | 'day' | 'minute',
  limits: AiRateLimits = DEFAULT_LIMITS,
): string {
  switch (reason) {
    case 'month':
      return `今月のAI利用回数の上限（${limits.perMonth}回）に達しました。翌月まで、または上限緩和をお待ちください。`;
    case 'day':
      return `本日のAI利用回数の上限（${limits.perDay}回）に達しました。時間をおいて再度お試しください。`;
    case 'minute':
      return 'AIへのリクエストが短時間に集中しています。少し時間をおいて再度お試しください。';
  }
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
    // 直近30日を母集合に、分・日・月（30日）を一度の集計で数える。
    return await trx`
      select
        count(*) filter (where created_at > now() - interval '1 minute') as minute_count,
        count(*) filter (where created_at > now() - interval '24 hours') as day_count,
        count(*) as month_count
      from pollenia.ai_usage_events
      where user_id = ${uid}::uuid and created_at > now() - interval '30 days'
    `;
  });
  const row = (
    rows as unknown as { minute_count: unknown; day_count: unknown; month_count: unknown }[]
  )[0];
  return {
    minute: Number(row.minute_count),
    day: Number(row.day_count),
    month: Number(row.month_count),
  };
}
