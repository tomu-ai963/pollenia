import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildLlms, buildRobots, checkConfig } from '../../geo/geo-lib.mjs';
import { config, expectedFiles, htmlFileOf, sameText } from '../../geo/sync.mjs';

// AI 検索向けの説明（geo/。geo-kit の geo-lib.mjs と、frontend/ に書き込む sync.mjs）。
// 生成物はコミットするので、設定や画面の HTML を直して `npm run geo` を忘れると落ちる。

const FRONT = new URL('../../frontend/', import.meta.url);
const path = (name: string) => fileURLToPath(new URL(name, FRONT));
const read = (name: string) => readFileSync(path(name), 'utf8');

describe('GEO（AI 検索向けの説明）', () => {
  it('設定に必須項目の抜けもサンプル文の残りもない', () => {
    expect(checkConfig(config)).toEqual({ errors: [], warnings: [] });
  });

  it('frontend/ の生成物が geo.config.json と一致している（ずれていたら npm run geo）', () => {
    for (const [rel, body] of Object.entries(expectedFiles())) {
      expect(existsSync(path(rel)), rel).toBe(true);
      expect(sameText(read(rel), body), `${rel} が古い`).toBe(true);
    }
  });

  it('pages のページはすべて frontend/ に HTML がある', () => {
    for (const p of config.pages) expect(existsSync(path(htmlFileOf(p.path))), p.path).toBe(true);
  });

  it('OG 画像がある', () => {
    expect(existsSync(path(String(config.ogImage).replace(/^\//, '')))).toBe(true);
  });

  it('robots.txt は API・ログイン・写真・ラベル印刷をクロールさせない', () => {
    const robots = buildRobots(config);
    for (const p of ['/api/', '/auth/', '/photos/', '/public/', '/labels']) {
      expect(robots, p).toContain(`Disallow: ${p}\n`);
    }
    // 公開系統ページ（/public?id=...）は止めない。/public/ は末尾の / で JSON の API だけに当たる
    expect(robots).not.toMatch(/Disallow: \/public\n/);
  });

  it('料金の表記が特商法の表記とそろっている', () => {
    const tokushoho = read('legal/tokushoho.html');
    expect(tokushoho).toContain('月額 300 円（税込）');
    const text = [buildLlms(config), ...config.intro].join('\n');
    const prices = [...text.matchAll(/月額\s*([\d,]+)\s*円/g)].map((m) => m[1]);
    expect(prices.length).toBeGreaterThan(0);
    for (const p of prices) expect(p).toBe('300');
  });

  it('ログイン欄の見出しの下に、JS なしでも読める紹介文がある', () => {
    const html = read('index.html');
    const card = html.slice(html.indexOf('id="auth-card"'), html.indexOf('id="auth-step-email"'));
    expect(card).toContain('<!-- GEO-BODY:');
    for (const line of config.intro) expect(card).toContain(line);
  });

  // 本番の静的アセットは text/plain に charset を付けない（wrangler dev は付けるのでローカルでは気づけない。
  // 種日和で 2026-11-24 のデプロイ後に curl で見つかった）。日本語の llms.txt が化けないよう _headers で付ける
  it('_headers が llms.txt・robots.txt に charset=utf-8 を付けている', () => {
    const headers = read('_headers').replaceAll('\r\n', '\n');
    for (const p of ['/llms.txt', '/robots.txt']) {
      expect(headers, p).toContain(`\n${p}\n  Content-Type: text/plain; charset=utf-8\n`);
    }
  });

  it('設定と生成スクリプトは配信しない（frontend/ の外に置く）', () => {
    expect(existsSync(path('geo'))).toBe(false);
    expect(existsSync(path('geo.config.json'))).toBe(false);
  });
});
