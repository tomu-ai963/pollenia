#!/usr/bin/env node
/**
 * `npm run dev` の入口。リポジトリ直下 .env（npm run db:up が生成）の DATABASE_URL を
 * Hyperdrive のローカル接続先として wrangler dev に渡す。値は表示しない。
 * 追加の引数はそのまま wrangler dev に渡る（例: npm run dev -- --port 8788）。
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workerDir = join(dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(join(workerDir, '..', '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL がありません。先に worker/ で npm run db:up と npm run db:migrate を実行してください。');
  process.exit(1);
}

const env = {
  ...process.env,
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: process.env.DATABASE_URL,
};
const child = spawn('npx', ['wrangler', 'dev', '--local', ...process.argv.slice(2)], {
  cwd: workerDir,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
child.on('exit', (code) => process.exit(code ?? 1));
