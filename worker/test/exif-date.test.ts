import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 写真のまとめ取り込み（⑧）: Exif の撮影日（frontend/src/exif-date.js）と、画面の表示まわりの小さな関数。

const FRONT = new URL('../../frontend/', import.meta.url);
const exif = (await import(new URL('src/exif-date.js', FRONT).href)) as {
  readExifDate: (b: ArrayBuffer) => string | null;
  exifDateToIso: (s: string) => string | null;
};
const seg = (await import(new URL('src/segregation-view.js', FRONT).href)) as {
  statText: (s: Record<string, unknown>) => string;
};
const ex = (await import(new URL('src/seed-exchange.js', FRONT).href)) as {
  useByText: (d: string | null, today: string) => string | null;
};

// テスト用の JPEG: SOI + APP1(Exif) + SOS。IFD0 に DateTime、Exif IFD に DateTimeOriginal
function jpegWithExif(opts: { original?: string; datetime?: string; little?: boolean }): ArrayBuffer {
  const little = opts.little ?? true;
  const tiff: number[] = [];
  const u16 = (v: number) => (little ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
  const u32 = (v: number) =>
    little ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24] : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0)).concat([0]);
  // TIFF ヘッダ（8）+ IFD0（2 + 2*12 + 4 = 30）→ データ領域は 38 から
  const ifd0Entries = opts.datetime ? 2 : 1;
  const ifd0Size = 2 + ifd0Entries * 12 + 4;
  const exifIfdOffset = 8 + ifd0Size;
  const exifIfdSize = 2 + 12 + 4;
  let dataOffset = exifIfdOffset + exifIfdSize;
  const data: number[] = [];
  tiff.push(...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8));
  tiff.push(...u16(ifd0Entries));
  if (opts.datetime) {
    tiff.push(...u16(0x0132), ...u16(2), ...u32(20), ...u32(dataOffset));
    data.push(...ascii(opts.datetime));
    dataOffset += 20;
  }
  tiff.push(...u16(0x8769), ...u16(4), ...u32(1), ...u32(exifIfdOffset), ...u32(0));
  tiff.push(...u16(1));
  if (opts.original) {
    tiff.push(...u16(0x9003), ...u16(2), ...u32(20), ...u32(dataOffset));
    data.push(...ascii(opts.original));
  } else {
    tiff.push(...u16(0x9286), ...u16(7), ...u32(0), ...u32(0)); // 関係ないタグ
  }
  tiff.push(...u32(0), ...data);
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const bytes = [0xff, 0xd8, 0xff, 0xe1, ...[(app1.length + 2) >> 8, (app1.length + 2) & 0xff], ...app1, 0xff, 0xda, 0, 2];
  return new Uint8Array(bytes).buffer;
}

describe('readExifDate', () => {
  it('DateTimeOriginal を優先（リトルエンディアン・ビッグエンディアン）', () => {
    expect(exif.readExifDate(jpegWithExif({ original: '2025:05:10 14:03:22', datetime: '2026:01:01 00:00:00' }))).toBe('2025-05-10');
    expect(exif.readExifDate(jpegWithExif({ original: '2024:12:31 23:59:59', little: false }))).toBe('2024-12-31');
  });

  it('DateTimeOriginal が無ければ DateTime', () => {
    expect(exif.readExifDate(jpegWithExif({ datetime: '2023:06:01 08:00:00' }))).toBe('2023-06-01');
  });

  it('Exif の無い JPEG・JPEG でないもの・壊れたものは null', () => {
    expect(exif.readExifDate(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]).buffer)).toBeNull();
    expect(exif.readExifDate(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer)).toBeNull();
    expect(exif.readExifDate(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x30, 0x45]).buffer)).toBeNull();
  });

  it('0000:00:00 や存在しない日は null', () => {
    expect(exif.exifDateToIso('0000:00:00 00:00:00')).toBeNull();
    expect(exif.exifDateToIso('2025:02:30 00:00:00')).toBeNull();
  });
});

describe('表示', () => {
  it('形質の分離の要約', () => {
    expect(seg.statText({ type: 'category', recorded: 8, counts: [{ value: 'ピンク', n: 5 }, { value: '白', n: 3 }] })).toBe(
      'ピンク 5・白 3（8本）',
    );
    expect(seg.statText({ type: 'number', recorded: 6, min: 45, max: 90, avg: 70.2, unit: 'cm' })).toBe(
      '45〜90 cm・平均 70.2（6本）',
    );
    expect(seg.statText({ type: 'number', recorded: 1, min: 4, max: 4, avg: 4, unit: null })).toBe('4・平均 4（1本）');
  });

  it('在庫の使用期限', () => {
    const today = '2026-11-27';
    expect(ex.useByText(null, today)).toBeNull();
    expect(ex.useByText('2026-11-20', today)).toBe('期限切れ（2026-11-20）');
    expect(ex.useByText('2026-12-07', today)).toBe('期限まであと 10 日');
    expect(ex.useByText('2027-06-01', today)).toBe('期限 2027-06-01');
  });

  it('新しい画面の部品も、利用者の入力を innerHTML で描かない', () => {
    for (const f of ['seed-exchange.js', 'exchange-view.js', 'segregation-view.js', 'trait-form.js']) {
      expect(readFileSync(new URL(`src/${f}`, FRONT), 'utf8')).not.toMatch(/innerHTML/);
    }
  });
});
