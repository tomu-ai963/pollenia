// geo-lib.mjs の型（TypeScript のプロジェクトから import するとき用）
export interface GeoOffer {
  name: string;
  /** "300" のような数字。0 は無料 */
  price: string;
  priceCurrency?: string;
  /** 継続課金の単位（JSON-LD の UnitPriceSpecification・llms.txt の「月額」） */
  period?: "month" | "year";
  description?: string;
}
export interface GeoPage {
  path: string;
  title: string;
  summary?: string;
  changefreq?: string;
  priority?: number;
  lastmod?: string;
}
export interface GeoBody {
  tag?: "div" | "main" | "section";
  /** true なら name */
  heading?: true | string;
  /** true なら tagline */
  lead?: true | string;
  /** "features" なら features をそのまま */
  items: string[] | "features";
  classes?: { root?: string; heading?: string; lead?: string; list?: string };
}
export interface GeoGuideSection {
  heading: string;
  /** 本文を設定のほかの項目から作る印（features = description と機能一覧、faq = FAQ） */
  from?: "features" | "faq";
  lead?: string;
  items?: string[];
  subsections?: { heading: string; items: string[] }[];
}
/** 使い方ガイド（利用者が URL を自分の AI に渡して使い方を聞く説明書。既定は /llms-full.txt） */
export interface GeoGuide {
  path: string;
  title: string;
  /** llms.txt の ## Docs でのリンクの説明 */
  summary: string;
  lead: string;
  aiNotes: string[];
  readingMap: { ask: string; section: string }[];
  sections: GeoGuideSection[];
}
export interface GeoConfig {
  siteUrl: string;
  name: string;
  tagline: string;
  description: string;
  lang?: string;
  author?: { name: string; url?: string };
  ogImage?: string;
  app?: {
    category?: string;
    os?: string;
    /** 従来の書き方（1件・期間なし）。offers を書いたら使わない */
    price?: string;
    priceCurrency?: string;
    offers?: GeoOffer[];
  };
  pages: GeoPage[];
  features?: string[];
  faq?: { q: string; a: string }[];
  body?: GeoBody;
  guide?: GeoGuide;
  aiCrawlers?: { allow?: string[]; disallowPaths?: string[] };
  /** 組み込み先が独自に足す項目（geo-lib は読まない） */
  [key: string]: unknown;
}
export const MARKER: string;
export function normPath(p: string): string;
export function findPage(c: GeoConfig, pathname: string): GeoPage | undefined;
export function checkConfig(c: GeoConfig): { errors: string[]; warnings: string[] };
export function buildRobots(c: GeoConfig): string;
export function buildLlms(c: GeoConfig): string;
export function buildSitemap(c: GeoConfig, lastmod?: string): string;
export function buildJsonLd(c: GeoConfig): string;
export function buildHead(c: GeoConfig, pagePath?: string): string;
export function injectHeadHtml(html: string, head: string): { html: string; removed: number; ok: boolean };
export function buildBody(c: GeoConfig): string;
export function buildGuide(c: GeoConfig): string;
export function injectBodyHtml(html: string, body: string): { html: string; found: boolean };
export function buildHeaders(c: GeoConfig, extraPaths?: string[]): string;
export function injectHeadersText(text: string, block: string): string;
