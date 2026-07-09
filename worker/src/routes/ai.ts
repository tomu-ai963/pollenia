import type { Env } from '../env';
import type { Sql } from '../lib/db';
import { json } from '../lib/http';
import { errorResponse } from '../lib/error-response';
import type { AuthedUser } from '../lib/auth';
import { asText, isUuid } from '../lib/validate';
import {
  AI_HISTORY_MAX_TURNS,
  AI_MARKETPLACES,
  AI_MESSAGE_MAX_LEN,
  type AiMarketplace,
} from '../constants';
import { buildListingFacts, collectUserSources } from '../lib/ai/context';
import { createEmbeddingProvider } from '../lib/ai/embeddings';
import { retrieveUserChunks, syncUserChunks } from '../lib/ai/rag';
import { generateConsultAnswer, generateListing, type ChatTurn } from '../lib/ai/anthropic';
import { consumeAiUsage, isAiRateLimited } from '../lib/ai/rate-limit';

// AI エンドポイント（Phase 3）。すべて JWT + profiles 行を要求（index.ts の共通認証を通過済み）。
// 参照データは常に「認証済みユーザー自身の記録」だけ（lib/ai/context.ts / rag.ts が uid で絞る）。
// Anthropic API キーはフロントに渡さず、この Worker 経由でのみ呼び出す。

// POST /api/ai/consult — 育種相談（チャット）。
// Request : { message: string, history?: [{ role: 'user'|'assistant', content: string }] }
//   history はクライアント保持（サーバーに会話を保存しない）。件数・長さは Worker が制限。
// Response: { answer, sources: [{ source_type, source_id, similarity }] }
export async function handleAiConsult(
  req: Request,
  env: Env,
  sql: Sql,
  user: AuthedUser,
): Promise<Response> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return errorResponse('INTERNAL_ERROR', { detail: 'ANTHROPIC_API_KEY is not configured' });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return errorResponse('VALIDATION_ERROR', { publicMessage: 'JSON ボディが必要です。' });

  const message = asText(body.message, AI_MESSAGE_MAX_LEN);
  if (!message) {
    return errorResponse('VALIDATION_ERROR', {
      publicMessage: `message は必須です（${AI_MESSAGE_MAX_LEN}文字以内）。`,
    });
  }

  const history = parseHistory(body.history);
  if (!history.ok) return history.response;

  // insert → count（advisory lock で直列化）の順で TOCTOU を防ぐ（lib/ai/rate-limit.ts）
  const counts = await consumeAiUsage(sql, user.uid, 'consult');
  if (isAiRateLimited(counts)) return errorResponse('RATE_LIMITED');

  const provider = createEmbeddingProvider(env);
  try {
    // 遅延同期（差分のみ再埋め込み）→ 自分のチャンクだけを近傍検索
    const { sources, overview } = await collectUserSources(sql, user.uid);
    await syncUserChunks(sql, provider, user.uid, sources);
    const chunks = await retrieveUserChunks(sql, provider, user.uid, message);

    const answer = await generateConsultAnswer(apiKey, message, history.value, chunks, overview);
    return json({
      answer,
      sources: chunks.map((c) => ({
        source_type: c.source_type,
        source_id: c.source_id,
        similarity: c.similarity,
      })),
    });
  } catch (e) {
    return errorResponse('INTERNAL_ERROR', { detail: e });
  }
}

// POST /api/ai/listing — 出品文自動生成。
// Request : { plant_id: uuid, marketplace: 'mercari' | 'yahoo_auction' }
// Response: { listing: { title, body }, marketplace }
// 対象は自分の（削除されていない）個体のみ。他人の個体は 404（存在を秘匿）。
// 生成は都度実行でサーバーに保存しない（結果の編集・コピーはフロント側）。
export async function handleAiListing(
  req: Request,
  env: Env,
  sql: Sql,
  user: AuthedUser,
): Promise<Response> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return errorResponse('INTERNAL_ERROR', { detail: 'ANTHROPIC_API_KEY is not configured' });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return errorResponse('VALIDATION_ERROR', { publicMessage: 'JSON ボディが必要です。' });

  if (!isUuid(body.plant_id)) {
    return errorResponse('VALIDATION_ERROR', { publicMessage: 'plant_id は必須です。' });
  }
  const marketplace = asMarketplace(body.marketplace);
  if (!marketplace) {
    return errorResponse('VALIDATION_ERROR', {
      publicMessage: `marketplace は ${AI_MARKETPLACES.join(' | ')} のいずれか。`,
    });
  }

  const rows = await sql`
    select id, name, species, notes, traits, origin_sowing_id
    from pollenia.plants
    where id = ${body.plant_id}::uuid and user_id = ${user.uid}::uuid and deleted_at is null
  `;
  if (rows.length === 0) return errorResponse('NOT_FOUND');
  const plant = rows[0];

  const counts = await consumeAiUsage(sql, user.uid, 'listing');
  if (isAiRateLimited(counts)) return errorResponse('RATE_LIMITED');

  try {
    const facts = await buildListingFacts(sql, user.uid, plant as never);
    const listing = await generateListing(apiKey, facts, marketplace);
    return json({ listing, marketplace });
  } catch (e) {
    return errorResponse('INTERNAL_ERROR', { detail: e });
  }
}

// --- バリデーション -----------------------------------------------------------

function asMarketplace(v: unknown): AiMarketplace | null {
  return typeof v === 'string' && (AI_MARKETPLACES as readonly string[]).includes(v)
    ? (v as AiMarketplace)
    : null;
}

// history の検証。role は user|assistant のみ、各 content は AI_MESSAGE_MAX_LEN 以内、
// 件数は AI_HISTORY_MAX_TURNS まで（超過は古い側を捨てるのではなくエラーにする —
// クライアント側で切り詰めて送る契約。暗黙の切り捨てで文脈が欠けるのを避ける）。
export function parseHistory(
  input: unknown,
): { ok: true; value: ChatTurn[] } | { ok: false; response: Response } {
  if (input === undefined || input === null) return { ok: true, value: [] };
  if (!Array.isArray(input) || input.length > AI_HISTORY_MAX_TURNS) {
    return {
      ok: false,
      response: errorResponse('VALIDATION_ERROR', {
        publicMessage: `history は最大 ${AI_HISTORY_MAX_TURNS} 件の配列。`,
      }),
    };
  }
  const turns: ChatTurn[] = [];
  for (const item of input) {
    const role = (item as Record<string, unknown>)?.role;
    const content = asText((item as Record<string, unknown>)?.content, AI_MESSAGE_MAX_LEN);
    if ((role !== 'user' && role !== 'assistant') || !content) {
      return {
        ok: false,
        response: errorResponse('VALIDATION_ERROR', { publicMessage: 'history が不正です。' }),
      };
    }
    turns.push({ role, content });
  }
  return { ok: true, value: turns };
}
