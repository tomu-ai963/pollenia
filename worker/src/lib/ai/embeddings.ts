// 埋め込みプロバイダーの抽象化（knowledge-rag の lib/embeddings.ts を踏襲）。
//   - openai : text-embedding-3-small（1536次元・ネイティブ）。OPENAI_API_KEY があれば使用
//   - voyage : voyage-3.5（Anthropic公式推奨プロバイダー）。VOYAGE_API_KEY があれば使用
//   - mock   : キーが無ければ決定的なローカル擬似1536次元ベクトル（ハッシュベース）
// どのプロバイダーでも EMBEDDING_DIM(=1536) に揃える（0005_ai.sql の vector(1536) と一致）。
import { EMBEDDING_DIM } from '../../constants';

export type EmbeddingInputType = 'query' | 'document';

export interface EmbeddingProvider {
  readonly name: string;
  // 複数テキストをまとめて埋め込む。inputType は voyage 等で query/document を区別するため（他は無視）。
  embed(texts: string[], inputType?: EmbeddingInputType): Promise<number[][]>;
}

// 環境変数（必要キーのみ）からプロバイダーを選ぶ。優先: openai > voyage > mock。
export function createEmbeddingProvider(env: {
  OPENAI_API_KEY?: string;
  VOYAGE_API_KEY?: string;
}): EmbeddingProvider {
  if (env.OPENAI_API_KEY) return new OpenAIEmbeddingProvider(env.OPENAI_API_KEY);
  if (env.VOYAGE_API_KEY) return new VoyageEmbeddingProvider(env.VOYAGE_API_KEY);
  // 本番でキーを入れ忘れたまま静かに劣化しないよう、mock 使用は毎回ログに残す
  // （Opus 4.8 レビュー L2。検索品質が落ちるだけでテナント分離は保たれる）。
  console.warn('AI embeddings: no OPENAI_API_KEY/VOYAGE_API_KEY — using mock provider (dev only)');
  return new MockEmbeddingProvider();
}

// pgvector へ渡す文字列リテラル '[v1,v2,...]'（::vector に明示キャストして渡す）。
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

// --- プロバイダー実装 -------------------------------------------------------

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  constructor(private readonly apiKey: string) {}

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: texts,
        dimensions: EMBEDDING_DIM, // ネイティブで1536。明示しておく。
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI embeddings failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    return json.data
      .sort((a, b) => a.index - b.index)
      .map((d) => toFixedDim(d.embedding));
  }
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'voyage';
  constructor(private readonly apiKey: string, private readonly model = 'voyage-3.5') {}

  async embed(texts: string[], inputType: EmbeddingInputType = 'document'): Promise<number[][]> {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        input_type: inputType,
      }),
    });
    if (!res.ok) {
      throw new Error(`Voyage embeddings failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    // voyage-3.5 は 1024 次元。toFixedDim で 1536 に 0 埋め+正規化し、provider 横断で次元を揃える。
    return json.data
      .sort((a, b) => a.index - b.index)
      .map((d) => toFixedDim(d.embedding));
  }
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'mock';

  // API キー無しでも RAG 配線が通るように、決定的な擬似ベクトルを生成する。
  // 文字ユニグラム + バイグラムをハッシュして次元へ加算する bag-of-grams 方式。
  // 完全な意味埋め込みではないが「語彙が重なるほど近い」ため、近傍検索を体感確認できる。
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => toFixedDim(hashEmbed(t)));
  }
}

// --- 共通ヘルパー -----------------------------------------------------------

// 任意長のベクトルを dim に揃える（切り詰め or 0埋め）→ L2 正規化（コサイン前提）。
export function toFixedDim(vec: number[], dim = EMBEDDING_DIM): number[] {
  const out = new Array<number>(dim).fill(0);
  const n = Math.min(dim, vec.length);
  for (let i = 0; i < n; i++) out[i] = vec[i];
  return l2normalize(out);
}

function l2normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  return vec.map((v) => v / norm);
}

function hashEmbed(text: string): number[] {
  const vec = new Array<number>(EMBEDDING_DIM).fill(0);
  const cleaned = text.toLowerCase().replace(/\s+/g, '');
  const grams: string[] = [];
  for (const ch of cleaned) grams.push(ch); // ユニグラム
  for (let i = 0; i < cleaned.length - 1; i++) grams.push(cleaned.slice(i, i + 2)); // バイグラム
  for (const g of grams) {
    const h = fnv1a(g);
    const idx = h % EMBEDDING_DIM;
    const sign = ((h >>> 16) & 1) === 0 ? 1 : -1; // 符号付きで衝突の打ち消しを許容
    vec[idx] += sign;
  }
  return vec;
}

// FNV-1a 32bit ハッシュ（決定的）
function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
