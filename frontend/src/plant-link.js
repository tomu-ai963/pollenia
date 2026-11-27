// 個体の直リンク（鉢・名札に貼る QR ラベルの中身）。
// `/?plant=<uuid>` を開くとログイン後にその個体の詳細が開く。
// リンク自体は秘密ではない（ログイン必須の画面で、他人の個体は API が 404 を返す）。
import qrcode from '../vendor/qrcode.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PLANT_PARAM = 'plant';

/** 個体の直リンク URL（QR に入れる文字列）。 */
export function plantLinkUrl(origin, plantId) {
  const url = new URL('/', origin);
  url.searchParams.set(PLANT_PARAM, plantId);
  return url.toString();
}

/** location.search から個体 ID を取り出す。UUID の形でなければ null（そのまま API に渡さない）。 */
export function parsePlantParam(search) {
  const id = new URLSearchParams(search).get(PLANT_PARAM);
  return id && UUID_RE.test(id) ? id.toLowerCase() : null;
}

/**
 * QR コードを SVG の path データにする（1 モジュール = 1 単位。余白は描画側で付ける）。
 * 誤り訂正 M（約15%）: 屋外の鉢ラベルの汚れ・擦れをある程度許す。型番 0 = 自動。
 */
export function qrPath(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    }
  }
  return { size, d };
}
