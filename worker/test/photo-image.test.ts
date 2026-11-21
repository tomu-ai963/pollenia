import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 画面側の写真の描き直し（frontend/src/photo-image.js）と、アップロードの流れ（app.js）。
// 位置情報などのメタデータを落としてから送ることを、画面のコードの形で固定する。
// frontend はビルドなしの素の JS なので、型を持たせずに読み込む。

const FRONT = new URL('../../frontend/src/', import.meta.url);
const read = (name: string) => readFileSync(fileURLToPath(new URL(name, FRONT)), 'utf8');

type PhotoImage = {
  targetSize: (w: number, h: number, longEdge?: number) => { width: number; height: number };
  PHOTO_LONG_EDGE: number;
};
const modulePath: string = new URL('photo-image.js', FRONT).href;
const { targetSize, PHOTO_LONG_EDGE } = (await import(modulePath)) as PhotoImage;

describe('targetSize', () => {
  it('長い辺を PHOTO_LONG_EDGE まで縮める（縦横比は保つ）', () => {
    expect(PHOTO_LONG_EDGE).toBe(2048);
    expect(targetSize(4032, 3024)).toEqual({ width: 2048, height: 1536 });
    expect(targetSize(3024, 4032)).toEqual({ width: 1536, height: 2048 });
  });

  it('小さい写真は拡大しない', () => {
    expect(targetSize(800, 600)).toEqual({ width: 800, height: 600 });
  });
});

describe('アップロードの流れ（app.js）', () => {
  const app = read('app.js');
  const handler = app.slice(app.indexOf("$('btn-upload-photo').onclick"));

  it('選んだファイルをそのまま送らず、描き直した JPEG を送る', () => {
    const reencode = handler.indexOf('reencodePhoto(file)');
    const create = handler.indexOf('api.createPhoto(');
    expect(reencode).toBeGreaterThan(-1);
    expect(reencode).toBeLessThan(create);
    expect(handler).toMatch(/content_type: 'image\/jpeg'/);
    expect(handler).toMatch(/api\.uploadPhoto\(upload, jpeg\)/);
    expect(handler).not.toMatch(/api\.uploadPhoto\(upload, file\)/);
  });

  it('描き直しは canvas から JPEG で書き出す（メタデータが残らない経路）', () => {
    const src = read('photo-image.js');
    expect(src).toMatch(/createImageBitmap\(file, \{ imageOrientation: 'from-image' \}\)/);
    expect(src).toMatch(/toBlob\(/);
    expect(src).toMatch(/'image\/jpeg'/);
  });
});
