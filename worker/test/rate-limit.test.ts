import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { limitPerUser } from '../src/lib/rate-limit';

// 利用者ごとの回数制限（src/lib/rate-limit.ts・wrangler.toml の [[ratelimits]]）。

const UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const binding = (impl: (o: { key: string }) => Promise<{ success: boolean }>) => ({ limit: vi.fn(impl) }) as unknown as RateLimit;

describe('limitPerUser', () => {
  it('上限内なら通す（null）。数える key は uid', async () => {
    const b = binding(async () => ({ success: true }));
    expect(await limitPerUser(b, UID)).toBeNull();
    expect((b.limit as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({ key: UID });
  });

  it('上限を超えたら 429（RATE_LIMITED）', async () => {
    const res = await limitPerUser(binding(async () => ({ success: false })), UID);
    expect(res?.status).toBe(429);
    expect(((await res!.json()) as { error: string }).error).toBe('RATE_LIMITED');
  });

  it('バインディングが無い・失敗したときは通さない（fail-closed で 503）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const missing = await limitPerUser(undefined, UID);
    expect(missing?.status).toBe(503);
    const thrown = await limitPerUser(binding(async () => { throw new Error('boom'); }), UID);
    expect(thrown?.status).toBe(503);
    expect(((await thrown!.json()) as { error: string }).error).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('ルートと設定', () => {
  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  // core.autocrlf=true の checkout では CRLF になる（正規表現の . は  を含まないので LF にそろえる）
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8').replace(/
/g, '
');

  it.each([
    ['IMPORT_LIMITER', "pathname === '/api/import/plants'"],
    ['EXCHANGE_LIMITER', "pathname === '/api/exchange'"],
    ['PHOTO_LIMITER', 'const plantPhotos ='],
  ])('%s は対象のルートで、ハンドラより前に数える', (name, routeMarker) => {
    const from = index.indexOf(routeMarker);
    const block = index.slice(from, from + 600);
    const limitAt = block.indexOf(`limitPerUser(env.${name}, user.uid)`);
    const handlerAt = block.search(/return handle(ImportPlants|CreateExchange|CreatePhoto)\(/);
    expect(limitAt).toBeGreaterThan(-1);
    expect(limitAt).toBeLessThan(handlerAt);
  });

  it('wrangler.toml にバインディングがあり、namespace_id が重ならない・期間は 10 か 60 秒', () => {
    const blocks = [...toml.matchAll(/\[\[ratelimits\]\]\s*\nname = "(\w+)".*?\nnamespace_id = "(\d+)"[\s\S]*?limit = (\d+)\s*\n\s*period = (\d+)/g)];
    expect(blocks.map((b) => b[1]).sort()).toEqual(['EXCHANGE_LIMITER', 'IMPORT_LIMITER', 'PHOTO_LIMITER']);
    expect(new Set(blocks.map((b) => b[2])).size).toBe(3);
    for (const b of blocks) expect(['10', '60']).toContain(b[4]);
  });
});
