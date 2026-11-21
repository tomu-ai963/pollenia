// 写真をアップロードする前に、端末の中で描き直して JPEG にする（2026-11-21）。
//
// **目的は位置情報などのメタデータを落とすこと。** スマホで撮った写真には撮影場所の GPS 座標が
// Exif として入っていることが多く、そのまま保存すると、公開した個体の写真から撮影場所
// （多くは自宅）が読み取れてしまう。canvas に描いてから書き出すと、Exif・XMP などは残らない。
//
// サーバ（worker/src/lib/jpeg.ts）も、メタデータの付いた JPEG を拒否する。ここを通さずに
// 送った写真は保存されない。
//
// - 向きは写真の Exif に従って描く（imageOrientation: 'from-image'）。描いた後は向きの情報が
//   要らない（画素そのものが正しい向きになる）
// - 長い辺は PHOTO_LONG_EDGE まで縮める（拡大はしない）。サーバの上限（10MB）にも収まる

export const PHOTO_LONG_EDGE = 2048;
export const PHOTO_JPEG_QUALITY = 0.86;

/** 縮小後の大きさ（長い辺を longEdge まで。小さい写真は拡大しない） */
export function targetSize(width, height, longEdge = PHOTO_LONG_EDGE) {
  const scale = Math.min(1, longEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** 画像ファイル → メタデータを持たない JPEG の Blob */
export async function reencodePhoto(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('この画像は読み込めませんでした。JPEG・PNG・WebP の写真を選んでください。');
  }
  try {
    const size = targetSize(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('画像を処理できませんでした。');
    // PNG の透明部分が黒くならないよう、白で下地を塗ってから描く
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    return await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('画像を処理できませんでした。'))),
        'image/jpeg',
        PHOTO_JPEG_QUALITY,
      );
    });
  } finally {
    bitmap.close?.();
  }
}
