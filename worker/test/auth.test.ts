import { describe, expect, it } from 'vitest';
import { normalizeEmail, postgresExecutor } from '../src/lib/auth';
import type { Sql } from '../src/lib/db';

// lib/auth.ts の純粋部分。deviceAuth のフロー全体は wrangler dev + 実 DB の E2E で確認する。

function fakeResult(rows: Record<string, unknown>[], count: number | null) {
  return Object.assign([...rows], { count });
}

describe('normalizeEmail', () => {
  it('trims and lower-cases (same as the SDK default and the users.email CHECK)', () => {
    expect(normalizeEmail('  Alice+x@Example.COM ')).toBe('alice+x@example.com');
  });
});

describe('postgresExecutor', () => {
  it('passes rows and a numeric rowCount through', async () => {
    const sql = { unsafe: async () => fakeResult([{ a: 1 }], 1) } as unknown as Sql;
    expect(await postgresExecutor(sql).query('select 1', [])).toEqual({ rows: [{ a: 1 }], rowCount: 1 });
  });

  it('refuses a missing row count instead of reading it as 0', async () => {
    const sql = { unsafe: async () => fakeResult([], null) } as unknown as Sql;
    await expect(postgresExecutor(sql).query('begin', [])).rejects.toThrow(/row count/);
  });

  it('runs transaction statements in order inside sql.begin', async () => {
    const seen: string[] = [];
    const tx = {
      unsafe: async (text: string) => {
        seen.push(text);
        return fakeResult([], 1);
      },
    };
    const sql = { begin: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as Sql;
    const out = await postgresExecutor(sql).transaction([
      { text: 'one', params: [] },
      { text: 'two', params: [] },
    ]);
    expect(seen).toEqual(['one', 'two']);
    expect(out).toHaveLength(2);
  });
});
