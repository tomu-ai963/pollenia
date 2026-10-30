import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { buildAuth, executionCtxOf, normalizeEmail, postgresExecutor } from '../src/lib/auth';
import type { Sql } from '../src/lib/db';

// lib/auth.ts の純粋部分と、DB を偽の sql に差し替えた buildAuth（executionCtx の受け渡し）。
// deviceAuth のフロー全体は wrangler dev + 実 DB の E2E で確認する。

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

describe('executionCtx (expired-session cleanup)', () => {
  // テスト専用の値（buildAuth の強度検査を通すだけ）
  const env = {
    DEVICE_AUTH_SECRET: 'pollenia-test-only-device-auth-secret-Qm7vX2pLk9Rw',
    MOCK_MAIL: '1',
  } as unknown as Env;

  // 期限切れの auth_sessions 行を返し、DELETE はこちらが resolve するまで終わらない sql
  function expiredSessionSql() {
    const deletes: string[] = [];
    let finishDelete: () => void = () => {};
    const sql = {
      unsafe: (text: string) => {
        if (/^SELECT \* FROM public\.auth_sessions\b/.test(text)) {
          return Promise.resolve(
            fakeResult(
              [
                {
                  sid_hash: 'h',
                  user_id: 'u',
                  subject_type: 'user',
                  created_at: 1,
                  last_seen_at: 1,
                  idle_expires_at: 2,
                  absolute_expires_at: 2,
                  scope: null,
                  meta: null,
                },
              ],
              1,
            ),
          );
        }
        if (/^DELETE FROM public\.auth_sessions\b/.test(text)) {
          deletes.push(text);
          return new Promise((resolve) => {
            finishDelete = () => resolve(fakeResult([], 1));
          });
        }
        return Promise.reject(new Error(`unexpected query: ${text}`));
      },
    } as unknown as Sql;
    return { sql, deletes, finish: () => finishDelete() };
  }

  it('hands the DELETE of an expired session to executionCtx.waitUntil (issued, not awaited)', async () => {
    const db = expiredSessionSql();
    const waited: Promise<unknown>[] = [];
    const { auth } = buildAuth(env, db.sql, 'http://localhost/api/me', { waitUntil: (p) => waited.push(p) });
    const app = new Hono();
    app.use('*', auth.middleware());
    app.get('/api/me', (c) => c.text('ok'));

    // DELETE はまだ終わっていないが、応答は返る（待つ処理だけが waitUntil に移っている）
    const res = await app.request('/api/me', { headers: { cookie: '__Host-session=sid-1' } });
    expect(res.status).toBe(401);
    expect(db.deletes).toHaveLength(1);
    expect(waited).toHaveLength(1);
    db.finish();
    await Promise.all(waited);
  });

  it('executionCtxOf returns the request ExecutionContext, or undefined where Hono has none', async () => {
    const seen: unknown[] = [];
    const app = new Hono();
    app.get('/', (c) => {
      seen.push(executionCtxOf(c));
      return c.text('ok');
    });
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };
    await app.fetch(new Request('http://localhost/'), {}, ctx as unknown as ExecutionContext);
    await app.request('/');
    expect(seen).toEqual([ctx, undefined]);
  });
});
