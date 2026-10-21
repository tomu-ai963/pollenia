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
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const envPath = join(root, '.env');

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
