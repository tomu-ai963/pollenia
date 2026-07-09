import { uuidArrayLiteral, type Sql } from '../db';
import { AI_EMBED_BATCH_SIZE, AI_TOP_K } from '../../constants';
import { toVectorLiteral, type EmbeddingProvider } from './embeddings';
import type { AiSource, AiSourceType } from './context';

// pollenia.ai_chunks の同期と近傍検索。
//
// knowledge-rag では supabase-js の .rpc() で match RPC を呼んでいたが、Pollenia の
// Worker は postgres.js の TCP 直接続なので素の SQL で完結させる（0005_ai.sql 参照）。
// **このモジュールが AI 用ベクトル検索の唯一の入口**であり、すべてのクエリを
// 検証済み uid で絞る。uid を外から生SQLで扱う経路を増やさないこと。

export interface RetrievedChunk {
  id: string;
  source_type: AiSourceType;
  source_id: string;
  content: string;
  similarity: number; // コサイン類似度（1 に近いほど近い）
}

// 遅延同期: 現在の記録（sources）と ai_chunks の差分だけを再埋め込みして upsert し、
// 記録側から消えたチャンクを削除する。差分検知は content の SHA-256。
export async function syncUserChunks(
  sql: Sql,
  provider: EmbeddingProvider,
  uid: string,
  sources: AiSource[],
): Promise<void> {
  const existing = await sql`
    select id, source_type, source_id, content_hash
    from pollenia.ai_chunks
    where user_id = ${uid}::uuid
  `;
  const existingByKey = new Map(
    existing.map((r) => [`${r.source_type}:${r.source_id}`, r.content_hash as string]),
  );

  const sourceKeys = new Set(sources.map((s) => `${s.source_type}:${s.source_id}`));

  // 記録側に存在しなくなったチャンク（削除・上限からあふれた古い記録）は落とす。
  const staleIds = existing
    .filter((r) => !sourceKeys.has(`${r.source_type}:${r.source_id}`))
    .map((r) => r.id as string);
  if (staleIds.length > 0) {
    await sql`
      delete from pollenia.ai_chunks
      where user_id = ${uid}::uuid and id = any(${uuidArrayLiteral(staleIds)}::uuid[])
    `;
  }

  // 新規 or 内容が変わったものだけ埋め込み直す。
  const toUpsert: (AiSource & { hash: string })[] = [];
  for (const s of sources) {
    const hash = await sha256Hex(s.content);
    if (existingByKey.get(`${s.source_type}:${s.source_id}`) !== hash) {
      toUpsert.push({ ...s, hash });
    }
  }
  if (toUpsert.length === 0) return;

  for (let i = 0; i < toUpsert.length; i += AI_EMBED_BATCH_SIZE) {
    const batch = toUpsert.slice(i, i + AI_EMBED_BATCH_SIZE);
    const vectors = await provider.embed(batch.map((b) => b.content), 'document');
    for (let j = 0; j < batch.length; j++) {
      const b = batch[j];
      await sql`
        insert into pollenia.ai_chunks (user_id, source_type, source_id, content, content_hash, embedding)
        values (${uid}::uuid, ${b.source_type}, ${b.source_id}::uuid,
                ${b.content}, ${b.hash}, ${toVectorLiteral(vectors[j])}::vector)
        on conflict (user_id, source_type, source_id)
        do update set content = excluded.content,
                      content_hash = excluded.content_hash,
                      embedding = excluded.embedding
      `;
    }
  }
}

// 質問を埋め込み → ユーザー自身のチャンクだけをコサイン近傍検索（上位 topK 件）。
export async function retrieveUserChunks(
  sql: Sql,
  provider: EmbeddingProvider,
  uid: string,
  question: string,
  topK = AI_TOP_K,
): Promise<RetrievedChunk[]> {
  const [embedding] = await provider.embed([question], 'query');
  const rows = await sql`
    select id, source_type, source_id, content,
           1 - (embedding <=> ${toVectorLiteral(embedding)}::vector) as similarity
    from pollenia.ai_chunks
    where user_id = ${uid}::uuid and embedding is not null
    order by embedding <=> ${toVectorLiteral(embedding)}::vector
    limit ${topK}
  `;
  return rows.map((r) => ({
    id: r.id,
    source_type: r.source_type,
    source_id: r.source_id,
    content: r.content,
    similarity: Number(r.similarity),
  }));
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
