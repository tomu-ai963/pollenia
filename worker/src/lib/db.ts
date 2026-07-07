import postgres from 'postgres';
import type { Env } from '../env';

export type Sql = postgres.Sql;

// pollenia スキーマへの DB アクセスは postgres.js の TCP 直接続で行う。
// supabase-js（PostgREST 経由）を使わない理由: pollenia は Phase 1 で PostgREST に
// 露出しない方針（README「掟」6）であり、非露出スキーマは service_role でも
// PostgREST からは呼べないため。認可の実体は Worker（本コード）+ 系統樹 RPC が担う。
//
// Workers ではリクエスト毎に接続を作り、ハンドラ完了後に ctx.waitUntil(sql.end()) で閉じる。
export function createDb(env: Env): Sql {
  return postgres(env.DATABASE_URL, {
    // 本番は Supavisor の transaction モード pooler（prepared statements 非対応）を想定。
    prepare: false,
    // Worker 1リクエストに 1接続で十分。
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
