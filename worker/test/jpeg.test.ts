import { describe, expect, it } from 'vitest';
import { inspectJpeg, photoBodyError } from '../src/lib/jpeg';
import { PHOTO_CONTENT_TYPES } from '../src/constants';

// 写真のメタデータ（Exif の GPS など）を持つ JPEG を拒否する検査（lib/jpeg.ts）。
// 種日和（bitane の tests/photos.test.mjs）の inspectJpeg のテストを移したもの。
// JPEG は画像として復号せず、セグメントの並びだけを組み立てる。

const seg = (marker: number, payload: number[]) => [
  0xff,
  marker,
  (payload.length + 2) >> 8,
  (payload.length + 2) & 0xff,
  ...payload,
];
const ascii = (s: string) => [...s].map((ch) => ch.charCodeAt(0));
const APP0 = seg(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const sof = (w: number, h: number) => seg(0xc0, [8, h >> 8, h & 0xff, w >> 8, w & 0xff, 1, 1, 0x11, 0]);
const SOS = seg(0xda, [1, 1, 0, 0, 0x3f, 0]);

function jpeg({ w = 900, h = 1200, extra = [] as number[], tail = [] as number[] } = {}) {
  return new Uint8Array([0xff, 0xd8, ...APP0, ...extra, ...sof(w, h), ...SOS, 0x12, 0x34, 0x56, 0xff, 0xd9, ...tail]);
}
// GPS は Exif（APP1）の中に入る
const EXIF = seg(0xe1, [...ascii('Exif'), 0, 0, 0x4d, 0x4d, 0, 0x2a]);
const XMP = seg(0xe1, [...ascii('http://ns.adobe.com/xap/1.0/'), 0]);
const IPTC = seg(0xed, ascii('Photoshop 3.0'));
const COMMENT = seg(0xfe, ascii('taken at home'));
const ICC = seg(0xe2, [...ascii('ICC_PROFILE'), 0, 1, 1]);

describe('inspectJpeg', () => {
  it('寸法を読む。ICC・詰め物・RST は通す', () => {
    expect(inspectJpeg(jpeg({ w: 640, h: 480 }))).toEqual({ ok: true, width: 640, height: 480 });
    expect(inspectJpeg(jpeg({ extra: ICC }))).toEqual({ ok: true, width: 900, height: 1200 });
    const padded = new Uint8Array([0xff, 0xd8, 0xff, ...APP0, ...sof(300, 300), ...SOS, 0, 0xff, 0xd9]);
    expect(inspectJpeg(padded).ok).toBe(true);
  });

  it('Exif・XMP・IPTC・注釈・末尾の余計なデータ・壊れた形は拒否', () => {
    expect(inspectJpeg(jpeg({ extra: EXIF }))).toEqual({ ok: false, reason: 'metadata' });
    expect(inspectJpeg(jpeg({ extra: XMP }))).toEqual({ ok: false, reason: 'metadata' });
    expect(inspectJpeg(jpeg({ extra: IPTC }))).toEqual({ ok: false, reason: 'metadata' });
    expect(inspectJpeg(jpeg({ extra: COMMENT }))).toEqual({ ok: false, reason: 'metadata' });
    expect(inspectJpeg(jpeg({ tail: [1, 2, 3] }))).toEqual({ ok: false, reason: 'trailing_data' });
    expect(inspectJpeg(new Uint8Array(ascii('\x89PNG\r\n\x1a\n')))).toEqual({ ok: false, reason: 'not_jpeg' });
    expect(inspectJpeg(new Uint8Array([0xff, 0xd8, ...APP0, ...SOS, 0, 0xff, 0xd9]))).toEqual({
      ok: false,
      reason: 'no_frame',
    });
    expect(inspectJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x40, 0x00, 0xff, 0xd9]))).toEqual({
      ok: false,
      reason: 'truncated',
    });
  });

  it('画像本体を最後まで読む。0xFF00・RST・プログレッシブの次のスキャン・Adobe は通す', () => {
    const head = [0xff, 0xd8, ...APP0, ...sof(400, 300)];
    const stuffed = new Uint8Array([...head, ...SOS, 0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd7, 0x78, 0xff, 0xd9]);
    expect(inspectJpeg(stuffed)).toEqual({ ok: true, width: 400, height: 300 });
    const DHT = seg(0xc4, [0, ...new Array(16).fill(0)]);
    const progressive = new Uint8Array([...head, ...SOS, 0x11, 0x22, ...DHT, ...SOS, 0x33, 0xff, 0x00, 0xff, 0xd9]);
    expect(inspectJpeg(progressive)).toEqual({ ok: true, width: 400, height: 300 });
    expect(inspectJpeg(jpeg({ extra: seg(0xee, [...ascii('Adobe'), 0, 100, 0, 0, 0, 0, 1]) })).ok).toBe(true);
  });

  it('1 枚目の EOI の後ろの 2 枚目・許可していない APPn・識別子の違う APP0 / APP2 は拒否', () => {
    expect(inspectJpeg(new Uint8Array([...jpeg(), ...jpeg({ extra: EXIF })]))).toEqual({
      ok: false,
      reason: 'trailing_data',
    });
    const early = new Uint8Array([0xff, 0xd8, ...APP0, ...sof(300, 300), ...SOS, 0x01, 0xff, 0xd9, ...ascii('hidden'), 0xff, 0xd9]);
    expect(inspectJpeg(early)).toEqual({ ok: false, reason: 'trailing_data' });
    expect(inspectJpeg(jpeg({ extra: seg(0xef, ascii('anything at all')) }))).toEqual({ ok: false, reason: 'metadata' });
    expect(inspectJpeg(jpeg({ extra: seg(0xe3, ascii('META')) }))).toEqual({ ok: false, reason: 'metadata' });
    expect(inspectJpeg(jpeg({ extra: seg(0xe2, [...ascii('MPF'), 0, 0x4d, 0x4d]) }))).toEqual({ ok: false, reason: 'metadata' });
    expect(inspectJpeg(jpeg({ extra: seg(0xe0, [...ascii('JFXX'), 0, 0x10]) }))).toEqual({ ok: false, reason: 'metadata' });
    expect(inspectJpeg(jpeg({ extra: seg(0xe2, ascii('ICC')) }))).toEqual({ ok: false, reason: 'metadata' });
    const lateComment = new Uint8Array([0xff, 0xd8, ...APP0, ...sof(300, 300), ...SOS, 0x01, ...COMMENT, 0xff, 0xd9]);
    expect(inspectJpeg(lateComment)).toEqual({ ok: false, reason: 'metadata' });
    expect(inspectJpeg(new Uint8Array([0xff, 0xd8, ...APP0, ...sof(300, 300), ...SOS, 0x01, 0x02]))).toEqual({
      ok: false,
      reason: 'truncated',
    });
  });
});

describe('photoBodyError（PUT /api/photos/:id が返す文言）', () => {
  it('メタデータの無い JPEG は null（受け付ける）', () => {
    expect(photoBodyError(jpeg())).toBeNull();
    expect(photoBodyError(jpeg({ extra: ICC }))).toBeNull();
  });

  it('位置情報などのメタデータ付きは、画面から送り直すよう案内する', () => {
    expect(photoBodyError(jpeg({ extra: EXIF }))).toMatch(/位置情報/);
    expect(photoBodyError(jpeg({ extra: XMP }))).toMatch(/位置情報/);
  });

  it('JPEG でない・壊れている・後ろにデータが付いているものは拒否する', () => {
    expect(photoBodyError(new Uint8Array(ascii('\x89PNG\r\n\x1a\n')))).not.toBeNull();
    expect(photoBodyError(jpeg({ tail: [1, 2, 3] }))).not.toBeNull();
    expect(photoBodyError(new Uint8Array([0xff, 0xd8, 0xff]))).not.toBeNull();
  });
});

describe('受け付ける形式', () => {
  it('新しいアップロードは JPEG だけ（PNG・WebP はメタデータの検査をしていないので受け付けない）', () => {
    expect(PHOTO_CONTENT_TYPES).toEqual({ 'image/jpeg': 'jpg' });
  });
});
