import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 法務ページ（frontend/legal/*.html。2026-11-21 制定）が、画面からたどれて、料金の表記が食い違わないこと。
// Stripe の審査と特商法（定期購入の表示）のために置いたページなので、消したりリンクを外したりすると落ちる。

const FRONT = new URL('../../frontend/', import.meta.url);
const path = (name: string) => fileURLToPath(new URL(name, FRONT));
const read = (name: string) => readFileSync(path(name), 'utf8');

const PAGES = ['legal/privacy.html', 'legal/terms.html', 'legal/tokushoho.html'];
const LINKS = ['/legal/terms', '/legal/privacy', '/legal/tokushoho'];

describe('法務ページ', () => {
  it('3 ページがある', () => {
    for (const p of PAGES) expect(existsSync(path(p)), p).toBe(true);
  });

  it('アプリの画面と公開系統ページの下部から 3 ページすべてにリンクしている', () => {
    for (const page of ['index.html', 'public.html']) {
      const html = read(page);
      for (const href of LINKS) expect(html, `${page} → ${href}`).toContain(`href="${href}"`);
    }
  });

  it('加入ボタンの近くに、料金・自動更新・解約と、規約・特商法へのリンクがある', () => {
    const html = read('index.html');
    const around = html.slice(html.indexOf('id="plan-card"'), html.indexOf('id="btn-subscribe"'));
    expect(around).toContain('月額 300 円（税込）');
    expect(around).toContain('自動で更新');
    expect(around).toContain('いつでも解約');
    expect(around).toContain('href="/legal/terms"');
    expect(around).toContain('href="/legal/tokushoho"');
  });

  it('料金・規約の案内は未加入のときだけ出す（加入中の人に「お申し込みの前に」と出さない）', () => {
    expect(read('index.html')).toContain('<p class="notice" id="plan-terms">月額 300 円（税込）');
    expect(read('src/app.js')).toContain("show('plan-terms', !isSubscribed());");
  });

  it('料金の表記がそろっている（画面・特商法・規約）', () => {
    expect(read('index.html')).toContain('¥300/月');
    expect(read('legal/tokushoho.html')).toContain('月額 300 円（税込）');
    expect(read('legal/terms.html')).toContain('月額 300 円（税込）');
  });

  it('プライバシーポリシーは、写真の位置情報を取り除くことと、AI に送るものを書いている', () => {
    const html = read('legal/privacy.html');
    expect(html).toContain('位置情報');
    expect(html).toContain('Anthropic');
    expect(html).toContain('OpenAI');
    expect(html).toContain('投稿、コメントは送りません');
  });
});
