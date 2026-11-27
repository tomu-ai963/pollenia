#!/usr/bin/env node
// GEO kit generator — 依存なし（Node 18+）
// 使い方: node geo-build.mjs [config] [outDir] [--inject] [--html-root=<dir>] [--headers=<file>] [--check] [--force]
//   例) node geo-build.mjs geo.config.json public
//       node geo-build.mjs geo/geo.config.json docs --inject
//       node geo-build.mjs geo/geo.config.json frontend/public --inject --html-root=frontend --headers=frontend/public/_headers --check
//
//   outDir            robots.txt / llms.txt / sitemap.xml の出力先（＝公開ディレクトリ）
//   --inject          各ページの HTML の <head> にタグを書き込む。body を設定していれば、
//                     HTML の <!-- GEO-BODY --><!-- /GEO-BODY --> の間に紹介文も書き込む
//   --html-root=<dir> 注入する HTML の場所（既定は outDir）。Vite の入口（index.html）が公開ディレクトリの外にある場合など
//   --headers=<file>  Cloudflare の _headers に、llms.txt・robots.txt の charset=utf-8 を書き込む（GEO ブロックだけ入れ替える）
//   --check           書き込まずに、生成物とファイルが一致するかだけを見る（ずれていれば終了コード 1。CI・テスト用）
//   --force           geo-build.mjs が作っていない既存の robots.txt などを上書きする
//
// 組み込み先のスクリプトから使う場合は planFiles() / syncFiles() を import する（下の export）。
// geo-head.html（貼り付け用スニペット）は --inject を使わないときだけ、config と同じ場所に出力する。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MARKER,
  checkConfig,
  normPath,
  buildRobots,
  buildLlms,
  buildSitemap,
  buildHead,
  buildBody,
  buildHeaders,
  buildGuide,
  injectHeadHtml,
  injectBodyHtml,
  injectHeadersText,
} from "./geo-lib.mjs";

/** 改行コードの違いを無視して比べる（git の core.autocrlf=true の checkout では CRLF になる） */
export function sameText(a, b) {
  return a.replaceAll("\r\n", "\n") === b.replaceAll("\r\n", "\n");
}

const readOr = (path, fallback = null) => (existsSync(path) ? readFileSync(path, "utf8") : fallback);

/** pages の path に対応する HTML（"/" → index.html、"/about" → about/index.html か about.html） */
export function htmlCandidates(path) {
  const n = normPath(path);
  return n === "/" ? ["index.html"] : [`${n.slice(1)}/index.html`, `${n.slice(1)}.html`];
}

/**
 * 生成物を計画する（書き込まない）。
 *   files    … { パス: 中身 }。HTML・_headers は今の中身に書き込んだ結果
 *   owned    … 中身をまるごと生成するファイル（手書きの既存ファイルを上書きしない判定の対象）
 *   warnings … ⚠ として出すもの
 * opts: { outDir, htmlRoot = outDir, inject = false, headers = null, headersExtra = [], lastmod, snippet = null }
 */
export function planFiles(c, opts) {
  const { outDir, htmlRoot = outDir, inject = false, headers = null, headersExtra = [], lastmod, snippet = null } = opts;
  const warnings = [];
  const owned = {
    [join(outDir, "robots.txt")]: buildRobots(c),
    [join(outDir, "llms.txt")]: buildLlms(c),
    [join(outDir, "sitemap.xml")]: buildSitemap(c, lastmod),
    // 使い方ガイド（設定に guide があるときだけ）。llms.txt の ## Docs からリンクされる
    ...(c.guide && { [join(outDir, c.guide.path)]: buildGuide(c) }),
  };
  const files = { ...owned };

  if (snippet) {
    files[snippet] = c.pages.map((p) => `<!-- ===== ${p.path} ===== -->\n${buildHead(c, p.path)}`).join("\n\n") + "\n";
  }

  if (inject) {
    let bodyPlaced = false;
    for (const p of c.pages) {
      const candidates = htmlCandidates(p.path);
      const file = candidates.map((f) => join(htmlRoot, f)).find(existsSync);
      if (!file) {
        warnings.push(`${p.path} の HTML が ${htmlRoot} に見つかりません（${candidates.join(" / ")}）。SPA の画面なら pages から外してください`);
        continue;
      }
      const r = injectHeadHtml(readFileSync(file, "utf8"), buildHead(c, p.path));
      if (!r.ok) {
        warnings.push(`${file} に <head> がありません`);
        continue;
      }
      let html = r.html;
      const b = injectBodyHtml(html, c.body ? buildBody(c) : "");
      if (b.found) {
        if (c.body) {
          html = b.html;
          bodyPlaced = true;
        } else warnings.push(`${file} に GEO-BODY の目印がありますが、設定に body がありません`);
      }
      files[file] = html;
    }
    if (c.body && !bodyPlaced) warnings.push("body を設定していますが、どの HTML にも <!-- GEO-BODY --><!-- /GEO-BODY --> の目印がありません");
  }

  // 使い方ガイドも .txt なので charset を付ける
  const extra = c.guide ? [c.guide.path, ...headersExtra] : headersExtra;
  if (headers) files[headers] = injectHeadersText(readOr(headers, ""), buildHeaders(c, extra));

  return { files, owned: new Set(Object.keys(owned)), warnings };
}

/**
 * 計画した生成物を書き込む（check なら書き込まずに照合だけ）。
 *   owned に入っているファイルが手書き（MARKER を含まない）で、force でなければ上書きせずに skipped へ
 * 戻り値: { written, stale, skipped }（どれもパスの配列）
 */
export function syncFiles({ files, owned = new Set() }, { check = false, force = false } = {}) {
  const written = [];
  const stale = [];
  const skipped = [];
  for (const [path, body] of Object.entries(files)) {
    const current = readOr(path);
    if (current !== null && sameText(current, body)) continue;
    if (current !== null && owned.has(path) && !current.includes(MARKER) && !force) {
      skipped.push(path);
      continue;
    }
    if (check) {
      stale.push(path);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    written.push(path);
  }
  return { written, stale, skipped };
}

// ---- CLI ----
function main(argv) {
  const opts = {};
  const flags = new Set();
  const positional = [];
  for (const a of argv) {
    const m = /^--(html-root|headers)=(.+)$/.exec(a);
    if (m) opts[m[1]] = m[2];
    else if (a.startsWith("--")) flags.add(a);
    else positional.push(a);
  }
  for (const f of flags) {
    if (!["--inject", "--force", "--check"].includes(f)) {
      console.error(`✖ 不明なオプション: ${f}`);
      return 1;
    }
  }
  const [configPath = "geo.config.json", outDir = "public"] = positional;
  const c = JSON.parse(readFileSync(configPath, "utf8"));
  const { errors, warnings } = checkConfig(c);
  if (errors.length) {
    errors.forEach((e) => console.error(`✖ ${e}`));
    return 1;
  }
  const check = flags.has("--check");
  const inject = flags.has("--inject");
  if (check && c.pages.some((p) => !p.lastmod))
    warnings.push("lastmod の無いページがあります。sitemap は実行日を入れるので、--check は日付が変わるとずれます（pages[].lastmod を書く）");

  const plan = planFiles(c, {
    outDir,
    htmlRoot: opts["html-root"] ?? outDir,
    inject,
    headers: opts.headers ?? null,
    lastmod: new Date().toISOString().slice(0, 10),
    snippet: inject ? null : join(dirname(configPath), "geo-head.html"),
  });
  warnings.push(...plan.warnings);

  const r = syncFiles(plan, { check, force: flags.has("--force") });
  for (const p of r.written) console.log(`✔ ${p}`);
  for (const p of r.skipped)
    warnings.push(`${p} は既存の手書きファイルのためスキップしました（上書きするなら --force。中身は先に移植すること）`);
  for (const p of r.stale) console.error(`✖ ${p} が geo.config.json と食い違っています（--check を外して作り直す）`);
  warnings.forEach((w) => console.warn(`⚠ ${w}`));
  return r.stale.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
