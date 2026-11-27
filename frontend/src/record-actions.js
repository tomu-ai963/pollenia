// 採種・播種・発芽の記録（交配記録一覧と「次の作業」の両方から使う）。
// どれも prompt で数を聞き、キャンセルなら false、記録したら true を返す。入力が不正なら Error を投げる。
import { api } from './api.js';

/** 端末の暦での今日（YYYY-MM-DD）。toISOString は UTC なので、日本の朝は前日になってしまう */
export function localToday(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** prompt の入力 → 0 以上の整数。空・不正は Error */
export function parseCount(input, what) {
  const n = Number(input);
  if (input.trim() === '' || !Number.isInteger(n) || n < 0) {
    throw new Error(`${what}は 0 以上の整数で入力してください。`);
  }
  return n;
}

export async function recordHarvest(crossingId) {
  const input = prompt('採種数（粒）:');
  if (input === null) return false;
  await api.createHarvest(crossingId, {
    harvest_date: localToday(),
    seed_count: parseCount(input, '採種数'),
  });
  return true;
}

export async function recordSowing(harvestId) {
  const input = prompt('播種数（粒）:');
  if (input === null) return false;
  await api.createSowing(harvestId, {
    sowing_date: localToday(),
    sowing_count: parseCount(input, '播種数'),
  });
  return true;
}

/** sowing: { id, sowing_date, sowing_count, germination_count, first_germination_date } */
export async function recordGermination(sowing) {
  const label = `${sowing.sowing_date ?? '日付なし'}にまいた${sowing.sowing_count ?? '?'}粒`;
  const input = prompt(`発芽数（${label}）:`, sowing.germination_count ?? '');
  if (input === null) return false;
  const patch = { germination_count: parseCount(input, '発芽数') };
  // 初発芽日が未記録なら今日にする（発芽までの日数の集計に使う）
  if (patch.germination_count > 0 && !sowing.first_germination_date) {
    patch.first_germination_date = localToday();
  }
  await api.updateSowing(sowing.id, patch);
  return true;
}
