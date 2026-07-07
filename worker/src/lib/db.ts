import postgres from 'postgres';
import type { Env } from '../env';

export type Sql = postgres.Sql;

// pollenia スキーマへの DB アクセスは postgres.js で行う。
// supabase-js（PostgREST 経由）を使わない理由: pollenia は Phase 1 で PostgREST に
// 露出しない方針（README「掟」6）であり、非露出スキーマは service_role でも
// PostgREST からは呼べないため。認可の実体は Worker（本コード）+ 系統樹 RPC が担う。
//
// 接続経路は Hyperdrive バインディングを最優先し、無ければ DATABASE_URL 直接続に
// フォールバックする（env.ts のコメント参照）。本番の接続プールと TCP/TLS/認証の
// ラウンドトリップ削減は Hyperdrive 側が担い、Worker はリクエスト毎に接続を作って
// ハンドラ完了後に ctx.waitUntil(sql.end()) で閉じる。
export function createDb(env: Env): Sql {
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!connectionString) {
    // 設定漏れは起動直後に明確に落とす（呼び出し側の try が 500 + ログにする）
    throw new Error('HYPERDRIVE バインディングか DATABASE_URL のどちらかが必要です');
  }
  return postgres(connectionString, {
    // prepared statements は使わない（後退厳禁）。Hyperdrive は postgres.js の
    // named prepared statements に対応するが、フォールバック経路が Supavisor の
    // transaction モード pooler（非対応）になりうるため、fail-safe 側に固定する。
    prepare: false,
    // Worker 1リクエストに 1接続で十分（プール実体は Hyperdrive 側）。
    max: 1,
    // 起動時の pg_type 取得ラウンドトリップを省く（enum は text として送受される）。
    fetch_types: false,
  });
}

// fetch_types を切っているため postgres.js は JS 配列を Postgres の配列リテラルに
// 自動シリアライズできない（素通しすると "a,b" という不正なリテラルになる）。
// uuid 配列は必ずこのヘルパーで `{a,b}` 形式にして `::uuid[]` キャスト付きで渡すこと。
// 要素は isUuid 検証済み、または DB から取得した uuid に限る（自由文字列を渡さない）。
export function uuidArrayLiteral(ids: string[]): string {
  return `{${ids.join(',')}}`;
}
