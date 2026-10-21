#!/usr/bin/env node
/**
 * db/migrations/*.sql をファイル名順に DATABASE_URL のデータベースへ適用する。
 *
 *   npm run db:migrate                     … リポジトリ直下 .env のローカル DB
 *   npm run db:migrate -- --allow-remote   … ローカル以外（本番 Neon など）。明示したときだけ
 *
 * 適用済みのファイルは public.schema_migrations に記録し、2回目以降は飛ばす。
 * 1ファイル = 1トランザクション（途中で失敗したらそのファイルは丸ごと戻る）。
 * 適用済みファイルの中身が変わっていたら（sha256 が違えば）止める。適用済みの
 * マイグレーションは書き換えず、新しい番号のファイルを足すこと。
 *
 * 接続先の DATABASE_URL は環境変数が優先、無ければ .env から読む。
 * 本番の接続文字列は環境変数で渡し、ファイルに書かない（シェル履歴に残さないため、
 * とむがプロンプトで入力する形で渡す）。
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrationsDir = join(root, 'db', 'migrations');

const urlFromDotEnv = !process.env.DATABASE_URL;
try {
  process.loadEnvFile(join(root, '.env')); // 既に process.env にある値は上書きしない
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL がありません（worker/ で npm run db:up を実行して .env を作るか、環境変数で渡してください）');
  process.exit(1);
}

const host = new URL(url).hostname;
const isLocal = host === '127.0.0.1' || host === 'localhost';
const allowRemote = process.argv.includes('--allow-remote');
// 本番に流すつもりで DATABASE_URL を渡し忘れると .env のローカルに落ちる。黙ってローカルに流さず止める
if (isLocal && allowRemote) {
  console.error(
    `--allow-remote が付いていますが、接続先がローカルです（${host}）。` +
      (urlFromDotEnv ? '環境変数 DATABASE_URL が無いので .env の値が使われています。' : ''),
  );
  process.exit(1);
}
if (!isLocal && !allowRemote) {
  console.error(`接続先がローカルではありません（${host}）。本番に流すなら --allow-remote を付けてください。`);
  process.exit(1);
}

const files = readdirSync(migrationsDir)
  .filter((f) => /^\d{4}_.+\.sql$/.test(f))
  .sort();

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  await sql`
    create table if not exists public.schema_migrations (
      version    text primary key,
      sha256     text not null,
      applied_at timestamptz not null default now()
    )
  `;
  const applied = new Map(
    (await sql`select version, sha256 from public.schema_migrations`).map((r) => [r.version, r.sha256]),
  );

  let count = 0;
  for (const file of files) {
    const body = readFileSync(join(migrationsDir, file), 'utf8');
    const sha256 = createHash('sha256').update(body).digest('hex');
    if (applied.has(file)) {
      if (applied.get(file) !== sha256) {
        throw new Error(`${file} は適用済みですが中身が変わっています。新しい番号のファイルで変更してください。`);
      }
      continue;
    }
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into public.schema_migrations (version, sha256) values (${file}, ${sha256})`;
    });
    console.log(`applied ${file}`);
    count++;
  }
  console.log(count === 0 ? '適用するマイグレーションはありません' : `${count} 件適用しました（${host}）`);
} finally {
  await sql.end({ timeout: 5 });
}
