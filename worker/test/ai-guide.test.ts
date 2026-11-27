import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildGuide, buildLlms, type GeoConfig } from '../../geo/geo-lib.mjs';
import {
  AI_GUIDE_COPIED,
  AI_GUIDE_COPY_FAILED,
  AI_GUIDE_PROMPTS,
  AI_GUIDE_URL,
  promptFor,
} from '../../frontend/src/ai-guide.js';

// 使い方ガイド（geo.config.json の guide → frontend/llms-full.txt）と、画面の「AI に使い方を聞く」
// （ログイン欄の「使う前に AI に聞いてみる」と「AI相談」タブ。frontend/src/ai-guide.js）。
//
// 見張りたいのは次の 3 つ:
// - **案内先が実在する** — 画面の URL が設定のガイドの URL と同じで、ボタンに頼み方の文がある
// - **画面とずれない** — ガイドが「」で挙げるボタン・画面の名前が、画面に実在する
//   （画面の文言を変えたらガイドも直す。ここで落ちる）
// - **記録の貼り付けを誘わない** — 頼み方の文は使い方を聞くだけ。ガイドも AI に貼らせないよう頼む

const FRONT = new URL('../../frontend/', import.meta.url);
const read = (name: string) => readFileSync(fileURLToPath(new URL(name, FRONT)), 'utf8');
const config = JSON.parse(readFileSync(new URL('../../geo/geo.config.json', import.meta.url), 'utf8')) as GeoConfig;
const guideConfig = config.guide!;
const guide = buildGuide(config);
const index = read('index.html');

describe('案内先が実在する', () => {
  it('画面が案内する URL は、設定のガイドの URL（本番のドメイン）と同じ', () => {
    expect(AI_GUIDE_URL).toBe(`${config.siteUrl}${guideConfig.path}`);
    expect(read(guideConfig.path.slice(1))).toContain(`# ${config.name} ${guideConfig.title}`);
  });

  it('ログイン欄と「AI相談」タブの 2 か所に、URL と「URL をコピー」がある', () => {
    const login = index.slice(index.indexOf('id="auth-card"'), index.indexOf('id="register-card"'));
    const aiTab = index.slice(index.indexOf('id="tab-ai"'), index.indexOf('id="tab-timeline"'));
    for (const [where, html, kind] of [
      ['ログイン欄', login, 'login'],
      ['AI相談タブ', aiTab, 'app'],
    ] as const) {
      expect(html, where).toContain(`href="${AI_GUIDE_URL}"`);
      expect(html, where).toContain(`>${AI_GUIDE_URL}</a>`);
      expect(html, where).toContain(`data-ai-guide="${kind}">URL をコピー</button>`);
      // コピーの結果を読み上げる場所（ボタンと同じ親の中）
      expect(html.slice(html.indexOf(`data-ai-guide="${kind}"`)), where).toMatch(/^[^]*?<p class="notice" role="status"><\/p>/);
    }
    expect(login).toContain('<h3>使う前に AI に聞いてみる</h3>');
    expect(aiTab).toContain('<h2>AI に使い方を聞く</h2>');
  });

  it('ボタンの種類ごとに、URL を含む頼み方の文がある', () => {
    for (const kind of ['login', 'app']) {
      expect(promptFor(kind)).toContain(AI_GUIDE_URL);
      expect(promptFor(kind)).toContain('説明書');
    }
    expect(promptFor('other')).toBeNull();
    expect(promptFor('toString')).toBeNull();
    expect(AI_GUIDE_COPIED).toContain('頼み方の文と一緒に');
    expect(AI_GUIDE_COPY_FAILED).not.toContain('長押し');
  });

  it('コピーの動作はログインの前に付ける（ログイン欄にもボタンがあるため）', () => {
    const app = read('src/app.js');
    expect(app).toContain("import { initAiGuide } from './ai-guide.js';");
    expect(app.indexOf('initAiGuide();')).toBeLessThan(app.lastIndexOf('refreshSession();'));
  });

  it('llms.txt からガイドへたどれ、_headers が charset=utf-8 を付ける', () => {
    expect(buildLlms(config)).toContain(`## Docs\n- [${guideConfig.title}](${AI_GUIDE_URL})`);
    const headers = read('_headers').replaceAll('\r\n', '\n');
    expect(headers).toContain(`\n${guideConfig.path}\n  Content-Type: text/plain; charset=utf-8\n`);
  });
});

describe('画面とずれない', () => {
  // ガイドが「」で挙げる名前のうち、ガイド自身の章・小見出しの名前以外は、画面のどこかにそのままある
  it('ガイドが「」で挙げるボタン・画面の名前が、画面に実在する', () => {
    const own = new Set([
      ...guideConfig.sections.map((s) => s.heading),
      ...guideConfig.sections.flatMap((s) => (s.subsections ?? []).map((sub) => sub.heading)),
    ]);
    const ui = [
      index,
      read('labels.html'),
      read('gallery.html'),
      ...readdirSync(fileURLToPath(new URL('src/', FRONT)))
        .filter((f) => f.endsWith('.js'))
        .map((f) => read(`src/${f}`)),
    ].join('\n');
    const names = [...new Set([...guide.matchAll(/「([^」]+)」/g)].map((m) => m[1]))].filter((n) => !own.has(n));
    expect(names.length).toBeGreaterThan(30);
    const missing = names.filter((n) => !ui.includes(n));
    expect(missing).toEqual([]);
  });

  it('料金はプランの表記（特商法・画面）とそろっている', () => {
    const prices = [...guide.matchAll(/月額\s*([\d,]+)\s*円/g)].map((m) => m[1]);
    expect(prices.length).toBeGreaterThan(0);
    for (const p of prices) expect(p).toBe('300');
    expect(read('legal/tokushoho.html')).toContain('月額 300 円（税込）');
  });
});

describe('記録の貼り付けを誘わない', () => {
  it('頼み方の文は使い方を聞くだけで、記録や写真を貼るよう誘わない', () => {
    for (const prompt of Object.values(AI_GUIDE_PROMPTS)) {
      for (const word of ['貼', '写真', '系統', 'データ']) expect(prompt, word).not.toContain(word);
    }
  });

  it('ガイドは AI に、記録の貼り付けを求めないよう頼んでいる', () => {
    const head = guide.slice(0, guide.indexOf('## 目次'));
    expect(head).toContain('貼り付けるよう求めないでください');
    expect(head).toContain('登録品種かどうか');
  });
});
