// JPEG の Exif から撮影日（DateTimeOriginal。無ければ DateTime）を YYYY-MM-DD で読む。
// 写真のまとめ取り込みで taken_at に使うだけ（位置情報などは読まない。送る前の描き直しで消える）。
// 読めない・無いときは null。

const TAG_DATETIME = 0x0132;
const TAG_EXIF_IFD = 0x8769;
const TAG_DATETIME_ORIGINAL = 0x9003;

function readAscii(view, offset, length) {
  let s = '';
  for (let i = 0; i < length && offset + i < view.byteLength; i++) {
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** "2025:05:10 14:03:22" → "2025-05-10"（不正なら null） */
export function exifDateToIso(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2})/.exec(s ?? '');
  if (!m || m[1] === '0000') return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== iso ? null : iso;
}

// IFD を読み、tag → 値（ASCII は文字列、LONG はオフセット）
function readIfd(view, tiff, ifdOffset, little) {
  const out = new Map();
  if (tiff + ifdOffset + 2 > view.byteLength) return out;
  const count = view.getUint16(tiff + ifdOffset, little);
  for (let i = 0; i < count; i++) {
    const entry = tiff + ifdOffset + 2 + i * 12;
    if (entry + 12 > view.byteLength) break;
    const tag = view.getUint16(entry, little);
    const type = view.getUint16(entry + 2, little);
    const n = view.getUint32(entry + 4, little);
    if (type === 2) {
      const at = n <= 4 ? entry + 8 : tiff + view.getUint32(entry + 8, little);
      out.set(tag, readAscii(view, at, n));
    } else if (type === 4) {
      out.set(tag, view.getUint32(entry + 8, little));
    }
  }
  return out;
}

export function readExifDate(buffer) {
  try {
    const view = new DataView(buffer);
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null; // JPEG ではない
    let p = 2;
    while (p + 4 <= view.byteLength) {
      const marker = view.getUint16(p);
      const size = view.getUint16(p + 2);
      if (marker === 0xffe1 && readAscii(view, p + 4, 4) === 'Exif') {
        const tiff = p + 10;
        const little = view.getUint16(tiff) === 0x4949;
        const ifd0 = readIfd(view, tiff, view.getUint32(tiff + 4, little), little);
        const exifPtr = ifd0.get(TAG_EXIF_IFD);
        const exif = typeof exifPtr === 'number' ? readIfd(view, tiff, exifPtr, little) : new Map();
        return exifDateToIso(exif.get(TAG_DATETIME_ORIGINAL)) ?? exifDateToIso(ifd0.get(TAG_DATETIME));
      }
      if (marker === 0xffda || (marker & 0xff00) !== 0xff00) break; // 画像データに入った
      p += 2 + size;
    }
  } catch {
    // 壊れたファイル
  }
  return null;
}
