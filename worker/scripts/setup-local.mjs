#!/usr/bin/env node
/**
 * ローカル DB（docker compose）用の .env をリポジトリ直下に生成する（gitignore 済み）。
 *
 * 実値をリポジトリに置かないための入口。パスワードはここでランダム生成し、
 * DATABASE_URL はローカルの docker compose（127.0.0.1:55435 / DB pollenia / 所有者ロール）を指す。
 * 生成した値はコンソールに出さない（ログやスクロールバックに残さないため）。
 * .env が既にあるときは何もしない（DB ボリュームのパスワードと食い違わせないため）。
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const envPath = join(root, '.env');
const devVarsPath = join(root, 'worker', '.dev.vars');

// worker/.dev.vars（wrangler dev 用）に、ローカルのログインに要るキーが無ければ追記する。
// 既にあるキーは変えない。DEVICE_AUTH_SECRET は SDK の要件（32 文字以上・十分なエントロピー）を満たす長さで生成。
function ensureDevVars() {
  const current = existsSync(devVarsPath) ? readFileSync(devVarsPath, 'utf8') : '';
  const present = new Set([...current.matchAll(/^([A-Z_]+)=/gm)].map((m) => m[1]));
  const wanted = {
    DEVICE_AUTH_SECRET: randomBytes(48).toString('base64url'),
    MOCK_MAIL: '1',
    PIN_PBKDF2_ITERATIONS: '1000',
  };
  const missing = Object.entries(wanted).filter(([key]) => !present.has(key));
  if (missing.length === 0) {
    console.log('keep    worker/.dev.vars');
    return;
  }
  const lines = missing.map(([key, value]) => `${key}="${value}"`);
  const sep = current === '' || current.endsWith('\n') ? '' : '\n';
  appendFileSync(devVarsPath, `${sep}\n# npm run db:up（setup-local.mjs）が追記\n${lines.join('\n')}\n`);
  console.log(`update  worker/.dev.vars（追記: ${missing.map(([key]) => key).join(', ')}）`);
}

ensureDevVars();

if (existsSync(envPath)) {
  console.log('keep    .env');
  process.exit(0);
}

const postgresPassword = randomBytes(24).toString('base64url');
const ownerPassword = randomBytes(24).toString('base64url');
const body = [
  '# npm run db:up（worker/scripts/setup-local.mjs）が生成。コミット禁止。',
  '# パスワードを変えるときは docker のボリュームも作り直す（npm run db:reset）。',
  `POSTGRES_PASSWORD="${postgresPassword}"`,
  `POLLENIA_OWNER_PASSWORD="${ownerPassword}"`,
  `DATABASE_URL="postgres://pollenia_owner:${ownerPassword}@127.0.0.1:55435/pollenia"`,
  '',
].join('\n');

writeFileSync(envPath, body, { encoding: 'utf8', flag: 'wx' });
console.log('created .env');
