import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 個体の直リンクと QR ラベル（frontend/src/plant-link.js・labels.html）。
// 鉢や名札に貼った QR を読むと /?plant=<uuid> が開き、ログイン後にその個体の詳細が開く。

const FRONT = new URL('../../frontend/', import.meta.url);
type PlantLink = {
  PLANT_PARAM: string;
  plantLinkUrl: (origin: string, id: string) => string;
  parsePlantParam: (search: string) => string | null;
  qrPath: (text: string) => { size: number; d: string };
};
const modulePath: string = new URL('src/plant-link.js', FRONT).href;
const { PLANT_PARAM, plantLinkUrl, parsePlantParam, qrPath } = (await import(modulePath)) as PlantLink;
const read = (name: string) => readFileSync(new URL(name, FRONT), 'utf8');

const ID = '3f2a9c1e-8b4d-4e6f-9a01-23456789abcd';
const ORIGIN = 'https://pollenia.tomu-ai.dev';

describe('plantLinkUrl / parsePlantParam', () => {
  it('直リンクはトップの ?plant=<id>', () => {
    expect(PLANT_PARAM).toBe('plant');
    expect(plantLinkUrl(ORIGIN, ID)).toBe(`${ORIGIN}/?plant=${ID}`);
  });

  it('作った URL から同じ ID を読み戻せる', () => {
    expect(parsePlantParam(new URL(plantLinkUrl(ORIGIN, ID)).search)).toBe(ID);
  });

  it('大文字の UUID は小文字にそろえる', () => {
    expect(parsePlantParam(`?plant=${ID.toUpperCase()}`)).toBe(ID);
  });

  it('UUID の形でないものは null（API に渡さない）', () => {
    expect(parsePlantParam('')).toBeNull();
    expect(parsePlantParam('?plant=')).toBeNull();
    expect(parsePlantParam('?plant=abc')).toBeNull();
    expect(parsePlantParam(`?plant=${ID}/../../api/me`)).toBeNull();
    expect(parsePlantParam(`?plant=${ID}x`)).toBeNull();
    expect(parsePlantParam(`?id=${ID}`)).toBeNull();
  });
});

describe('qrPath', () => {
  it('直リンク（72文字）は誤り訂正 M で型番5（37×37）に収まる', () => {
    const { size, d } = qrPath(plantLinkUrl(ORIGIN, ID));
    expect(size).toBe(37);
    // 左上の位置検出パターン: 外枠の角と中心 3×3 が黒、その間の 1 周は白
    expect(d).toContain('M0 0h1v1h-1z');
    expect(d).toContain('M3 3h1v1h-1z');
    expect(d).not.toContain('M1 1h1v1h-1z');
  });

  it('同じ入力からは同じ QR になる', () => {
    expect(qrPath('x')).toEqual(qrPath('x'));
  });
});

describe('画面からの導線', () => {
  it('labels.html（/labels）は labels.js を読み込み、記録画面から開ける', () => {
    expect(read('labels.html')).toContain('src="src/labels.js"');
    expect(read('index.html')).toContain('href="/labels"');
  });

  it('QR は端末内で作る（vendor のライブラリを同一オリジンから読む）', () => {
    expect(read('src/plant-link.js')).toContain("from '../vendor/qrcode.mjs'");
  });

  it('撮影して記録はカメラを直接起動する', () => {
    expect(read('index.html')).toMatch(/id="photo-camera"[^>]*capture="environment"/);
  });
});
