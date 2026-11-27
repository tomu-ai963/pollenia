#!/usr/bin/env node
// GEO Kit（geo-lib.mjs）の出力を Pollenia の画面（frontend/）に書き込む。
//   node geo/sync.mjs          … 生成して書き込む（worker/ では `npm run geo`）
//   node geo/sync.mjs --check  … 書き込まずに、コミット済みのファイルと一致するかだけを見る
//
// - frontend/robots.txt・llms.txt・sitemap.xml を geo.config.json から生成する
// - pages に書いた各ページの HTML の <head> に、メタタグ・OGP・JSON-LD を書き込む（<!-- GEO --> 〜 <!-- /GEO -->）
// - index.html のログイン欄に、JS なしでも読める紹介文を書き込む（<!-- GEO-BODY --> 〜。下の buildBody）
//
// **Worker のミドルウェア（geo-worker.mjs）は使わない。** frontend/ は [assets] として Worker を通らずに
// 返っており、注入を Worker でやるには run_worker_first に pages のパスを足す必要がある。画面はビルドなしの
// 静的ファイルなので、生成物をソースに書き込めば Worker にも wrangler.toml にも触らずに済む（種日和と同じ方式）。
//
// geo/ を frontend/ の外に置くのは、frontend/ がまるごと公開されるから（設定や生成スクリプトは配信しない）。
// geo-lib.mjs は geo-kit 9fef81b のコピー。**手を入れない**。kit を更新したら丸ごと差し替える。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKER, checkConfig, normPath, buildRobots, buildLlms, buildSitemap, buildHead, injectHeadHtml } from './geo-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = join(ROOT, 'frontend');
export const config = JSON.parse(readFileSync(join(ROOT, 'geo/geo.config.json'), 'utf8'));

/** 改行コードの違いを無視して比べる（core.autocrlf=true の checkout では CRLF になる） */
export function sameText(a, b) {
  return a.replaceAll('\r\n', '\n') === b.replaceAll('\r\n', '\n');
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

/** pages の path → frontend/ の HTML（"/" → index.html、"/gallery" → gallery.html） */
export function htmlFileOf(path) {
  const n = normPath(path);
  return n === '/' ? 'index.html' : `${n.slice(1)}.html`;
}

/**
 * ログイン欄の見出しの下に置く紹介文（`intro`）。初めて来た人と、JS を実行しないクローラーの両方に
 * 「何のアプリか・いくらか・記録は誰に見えるか」を伝える。ログイン欄はログイン後に隠れるので、
 * 使っている人の画面には出ない
 */
export function buildBody(c) {
  const items = (c.intro ?? []).map((t) => `          <li>${esc(t)}</li>`).join('\n');
  return `<!-- GEO-BODY: ${MARKER} -->
      <div class="intro">
        <p class="intro-lead">${esc(c.tagline)}</p>
        <ul class="intro-list">
${items}
        </ul>
      </div>
      <!-- /GEO-BODY -->`;
}

// 見出しの直後〜「1. メールアドレス」のコメントの直前を毎回入れ替える（何度実行しても同じ結果）
const BODY_RE = /(<section class="card hidden" id="auth-card">\s*<h2>[^<]*<\/h2>)[\s\S]*?(<!-- 1\. メールアドレス)/;

function injectBody(html, body) {
  if (!BODY_RE.test(html)) throw new Error('index.html のログイン欄（#auth-card の見出しと「1. メールアドレス」）が見つかりません');
  return html.replace(BODY_RE, (_, open, next) => `${open}\n      ${body}\n\n      ${next}`);
}

/** 生成物の一覧（frontend/ からの相対パス → 中身）。HTML は現在の中身に注入した結果 */
export function expectedFiles() {
  if (!config.intro?.length) throw new Error('geo.config.json に intro（ログイン欄の紹介文）がありません');
  const files = {
    'robots.txt': buildRobots(config),
    'llms.txt': buildLlms(config),
    // lastmod は pages[].lastmod から取る（実行日を入れると生成のたびに差分が出る）
    'sitemap.xml': buildSitemap(config),
  };
  for (const page of config.pages) {
    const rel = htmlFileOf(page.path);
    const out = injectHeadHtml(readFileSync(join(FRONTEND, rel), 'utf8'), buildHead(config, page.path));
    if (!out.ok) throw new Error(`${rel} に <head> がありません`);
    files[rel] = rel === 'index.html' ? injectBody(out.html, buildBody(config)) : out.html;
  }
  return files;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { errors, warnings } = checkConfig(config);
  // ⚠ も止める（サンプル文の残りや ogImage の欠けを黙って出さない）
  for (const m of [...errors, ...warnings]) console.error(`✖ ${m}`);
  if (errors.length || warnings.length) process.exit(1);

  const check = process.argv.includes('--check');
  let stale = 0;
  for (const [rel, body] of Object.entries(expectedFiles())) {
    const path = join(FRONTEND, rel);
    let current = null;
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      // まだ無い
    }
    if (current !== null && sameText(current, body)) continue;
    if (check) {
      console.error(`✖ frontend/${rel} が geo.config.json と食い違っています（npm run geo で作り直す）`);
      stale++;
    } else {
      writeFileSync(path, body);
      console.log(`✔ frontend/${rel}`);
    }
  }
  if (stale) process.exit(1);
}
