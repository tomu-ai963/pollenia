// geo-lib.mjs（GEO Kit。依存なしの JS）の型。テストから読むぶんだけ書く
export interface GeoConfig {
  siteUrl: string;
  name: string;
  tagline: string;
  description: string;
  pages: { path: string; title: string; summary?: string; lastmod?: string }[];
  features?: string[];
  faq?: { q: string; a: string }[];
  /** ログイン欄の紹介文（sync.mjs の buildBody が読む。geo-lib 本体は見ない） */
  intro: string[];
  aiCrawlers?: { allow?: string[]; disallowPaths?: string[] };
  [key: string]: unknown;
}
export const MARKER: string;
export function normPath(p: string): string;
export function checkConfig(c: GeoConfig): { errors: string[]; warnings: string[] };
export function buildRobots(c: GeoConfig): string;
export function buildLlms(c: GeoConfig): string;
export function buildSitemap(c: GeoConfig, lastmod?: string): string;
export function buildHead(c: GeoConfig, pagePath?: string): string;
export function injectHeadHtml(html: string, head: string): { html: string; removed: number; ok: boolean };
