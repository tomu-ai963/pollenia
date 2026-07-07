import type { Visibility } from './visibility';

// 入力バリデーションの小道具。「不正なら null を返す」流儀で統一し、
// 呼び出し側（routes）が VALIDATION_ERROR に変換する。

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VISIBILITIES: Visibility[] = ['public', 'followers', 'private'];

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export function asVisibility(v: unknown): Visibility | null {
  return typeof v === 'string' && (VISIBILITIES as string[]).includes(v)
    ? (v as Visibility)
    : null;
}

// 'YYYY-MM-DD' のみ受け付ける（date カラムに渡す）。実在日付かは Date で確認する。
export function asDateStr(v: unknown): string | null {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return null;
  const t = Date.parse(`${v}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  // 2月30日など、パースで丸められる不正日付を弾く
  return new Date(t).toISOString().slice(0, 10) === v ? v : null;
}

export function asNonNegInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

// trim して 1..maxLen 文字なら返す。空・型不一致・超過は null。
export function asText(v: unknown, maxLen: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length >= 1 && s.length <= maxLen ? s : null;
}

// クエリ文字列の整数を [min, max] にクランプする。未指定・非数値は dflt。
// depth / limit / offset をクライアント指定のまま DB に渡さないための関門。
export function clampIntParam(
  raw: string | null,
  min: number,
  max: number,
  dflt: number,
): number {
  if (raw === null || raw.trim() === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
