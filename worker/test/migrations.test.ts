import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// db/migrations/0002_workers_auth.sql は workers-auth の pg マイグレーション原本の連結。
// SDK を上げたのに作り直し忘れる、を防ぐ（原本の中身がそのまま含まれていること）。

const root = join(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const sdkDir = dirname(require.resolve('@tomu-ai/workers-auth/package.json'));

const normalize = (s: string) => s.replace(/\r\n/g, '\n').trim();

describe('db/migrations', () => {
  const auth = normalize(readFileSync(join(root, 'db', 'migrations', '0002_workers_auth.sql'), 'utf8'));

  for (const file of ['0001_sessions.sql', '0006_device_auth.sql']) {
    it(`0002_workers_auth.sql contains workers-auth migrations/pg/${file} verbatim`, () => {
      const original = normalize(readFileSync(join(sdkDir, 'migrations', 'pg', file), 'utf8'));
      expect(auth.includes(original)).toBe(true);
    });
  }

  it('0001_schema.sql no longer depends on Supabase roles or auth schema', () => {
    const schema = readFileSync(join(root, 'db', 'migrations', '0001_schema.sql'), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
    expect(schema).not.toMatch(/auth\.users|auth\.uid\(\)|service_role|\bauthenticated\b/);
  });
});
