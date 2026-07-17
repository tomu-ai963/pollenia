import { describe, expect, it } from 'vitest';
import { parseHistory } from '../src/routes/ai';
import { aiRateLimitReason, isAiRateLimited } from '../src/lib/ai/rate-limit';
import { normalizeListing } from '../src/lib/ai/anthropic';
import {
  MockEmbeddingProvider,
  toFixedDim,
  toVectorLiteral,
} from '../src/lib/ai/embeddings';
import {
  AI_HISTORY_MAX_TURNS,
  AI_LISTING_TITLE_MAX,
  AI_MESSAGE_MAX_LEN,
  AI_RATE_LIMIT_PER_DAY,
  AI_RATE_LIMIT_PER_MINUTE,
  AI_RATE_LIMIT_PER_MONTH,
  EMBEDDING_DIM,
} from '../src/constants';

describe('parseHistory', () => {
  it('未指定は空履歴', () => {
    expect(parseHistory(undefined)).toEqual({ ok: true, value: [] });
    expect(parseHistory(null)).toEqual({ ok: true, value: [] });
  });

  it('正常な履歴を通す', () => {
    const r = parseHistory([
      { role: 'user', content: '香りの強い個体は？' },
      { role: 'assistant', content: '記録では…' },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toHaveLength(2);
  });

  it('件数超過を拒否', () => {
    const items = Array.from({ length: AI_HISTORY_MAX_TURNS + 1 }, () => ({
      role: 'user',
      content: 'x',
    }));
    expect(parseHistory(items).ok).toBe(false);
  });

  it('不正 role・長すぎる content・非配列を拒否', () => {
    expect(parseHistory([{ role: 'system', content: 'x' }]).ok).toBe(false);
    expect(parseHistory([{ role: 'user', content: 'x'.repeat(AI_MESSAGE_MAX_LEN + 1) }]).ok).toBe(
      false,
    );
    expect(parseHistory([{ role: 'user' }]).ok).toBe(false);
    expect(parseHistory('not-array').ok).toBe(false);
  });
});

describe('isAiRateLimited / aiRateLimitReason', () => {
  // counts は「今回の試行を含む」件数（insert → count の順。lib/ai/rate-limit.ts）。
  it('上限件数ちょうどまでは通す', () => {
    expect(isAiRateLimited({ minute: 1, day: 1, month: 1 })).toBe(false);
    expect(
      isAiRateLimited({
        minute: AI_RATE_LIMIT_PER_MINUTE,
        day: AI_RATE_LIMIT_PER_DAY,
        month: AI_RATE_LIMIT_PER_MONTH,
      }),
    ).toBe(false);
    expect(aiRateLimitReason({ minute: 1, day: 1, month: 1 })).toBeNull();
  });

  it('分・日・月いずれかの上限超過で拒否', () => {
    expect(isAiRateLimited({ minute: AI_RATE_LIMIT_PER_MINUTE + 1, day: 10, month: 10 })).toBe(true);
    expect(isAiRateLimited({ minute: 1, day: AI_RATE_LIMIT_PER_DAY + 1, month: 10 })).toBe(true);
    expect(isAiRateLimited({ minute: 1, day: 1, month: AI_RATE_LIMIT_PER_MONTH + 1 })).toBe(true);
  });

  it('超過理由は 月 > 日 > 分 の優先度で返す', () => {
    // 3 種すべて超過 → 最も重い month を返す
    expect(
      aiRateLimitReason({
        minute: AI_RATE_LIMIT_PER_MINUTE + 1,
        day: AI_RATE_LIMIT_PER_DAY + 1,
        month: AI_RATE_LIMIT_PER_MONTH + 1,
      }),
    ).toBe('month');
    expect(
      aiRateLimitReason({ minute: AI_RATE_LIMIT_PER_MINUTE + 1, day: AI_RATE_LIMIT_PER_DAY + 1, month: 1 }),
    ).toBe('day');
    expect(aiRateLimitReason({ minute: AI_RATE_LIMIT_PER_MINUTE + 1, day: 1, month: 1 })).toBe('minute');
  });
});

describe('normalizeListing', () => {
  it('title/body を trim して返す', () => {
    expect(normalizeListing({ title: '  A  ', body: ' B ' }, 'yahoo_auction')).toEqual({
      title: 'A',
      body: 'B',
    });
  });

  it('メルカリの title は上限にクランプ', () => {
    const long = 'あ'.repeat(AI_LISTING_TITLE_MAX + 10);
    const r = normalizeListing({ title: long, body: 'b' }, 'mercari');
    expect(r.title).toHaveLength(AI_LISTING_TITLE_MAX);
  });

  it('ヤフオクはクランプしない', () => {
    const long = 'あ'.repeat(AI_LISTING_TITLE_MAX + 10);
    expect(normalizeListing({ title: long, body: 'b' }, 'yahoo_auction').title).toBe(long);
  });

  it('欠損・不正型は空文字', () => {
    expect(normalizeListing({}, 'mercari')).toEqual({ title: '', body: '' });
    expect(normalizeListing({ title: 1, body: null }, 'mercari')).toEqual({ title: '', body: '' });
    expect(normalizeListing(null, 'mercari')).toEqual({ title: '', body: '' });
  });
});

describe('embeddings', () => {
  it('mock は決定的で次元が揃い L2 正規化されている', async () => {
    const p = new MockEmbeddingProvider();
    const [a1] = await p.embed(['香りの強い個体']);
    const [a2] = await p.embed(['香りの強い個体']);
    expect(a1).toEqual(a2);
    expect(a1).toHaveLength(EMBEDDING_DIM);
    const norm = Math.sqrt(a1.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it('mock は語彙が重なるほど近い（コサイン類似度）', async () => {
    const p = new MockEmbeddingProvider();
    const [q, similar, other] = await p.embed([
      '香りの強い個体はどれ？',
      '【個体】バラA / 特性: 香りの強さ=5/5, 香りの系統=ダマスク',
      '【播種】交配 X × Y の種子を播種 / 播種数: 20粒',
    ]);
    const cos = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
    expect(cos(q, similar)).toBeGreaterThan(cos(q, other));
  });

  it('toFixedDim は切り詰め/0埋めで次元を揃える', () => {
    expect(toFixedDim([1, 2, 3], 5)).toHaveLength(5);
    expect(toFixedDim(new Array(10).fill(1), 5)).toHaveLength(5);
  });

  it('toVectorLiteral は pgvector リテラル形式', () => {
    expect(toVectorLiteral([0.5, -1, 2])).toBe('[0.5,-1,2]');
  });
});
