// geo-build.mjs の型（組み込み先のスクリプト・テストから import するとき用）
import type { GeoConfig } from "./geo-lib.mjs";
export interface PlanOptions {
  outDir: string;
  /** 注入する HTML の場所（既定は outDir） */
  htmlRoot?: string;
  inject?: boolean;
  /** Cloudflare の _headers のパス（charset の GEO ブロックを書き込む） */
  headers?: string | null;
  /** _headers で charset を付けるほかの .txt（例: "/llms-full.txt"） */
  headersExtra?: string[];
  /** pages[].lastmod が無いページの sitemap の lastmod */
  lastmod?: string;
  /** geo-head.html の出力先（null なら出さない） */
  snippet?: string | null;
}
export interface Plan {
  files: Record<string, string>;
  owned: Set<string>;
  warnings: string[];
}
export const VERSION: string;
export function sameText(a: string, b: string): boolean;
export function htmlCandidates(path: string): string[];
export function planFiles(c: GeoConfig, opts: PlanOptions): Plan;
export function syncFiles(
  plan: Pick<Plan, "files"> & { owned?: Set<string> },
  opts?: { check?: boolean; force?: boolean },
): { written: string[]; stale: string[]; skipped: string[] };
