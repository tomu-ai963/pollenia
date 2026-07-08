import {
  BLOOM_SEASONS,
  MAX_NAME_LEN,
  TRAIT_FRAGRANCE_STRENGTH_MAX,
  TRAIT_MAX_FLOWER_CM,
  TRAIT_MAX_HEIGHT_CM,
} from '../constants';
import { asText } from './validate';

// plants.traits（構造化特性）のパース／正規化。
//
// 方針:
//   * 全項目任意。空欄（null / undefined）はキーごと落とす（「空欄は traits に含めない」）。
//     結果が {} でも正当（未入力の個体）。
//   * 既知キーのみ受け付け、未知キーは拒否する。JSONB は自由形だが、後段（Phase 3）で
//     AI が読む列に不定形・任意のクライアント入力を溜め込ませない（データ衛生・プロンプト混入対策）。
//     ※ 項目追加時はここに case を1つ足すだけでよい（DB マイグレーションは不要）。
//   * エラー文言はクライアントの入力値（キー名・値）を反映しない固定文言にする
//     （error-response の「詳細はログのみ」方針・反射の回避）。

const FRAGRANCE_TYPE_MAX = MAX_NAME_LEN;

export type TraitParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string };

export function parsePlantTraits(input: unknown): TraitParseResult {
  // 未指定・null は「特性なし」= {}。
  if (input === null || input === undefined) return { ok: true, value: {} };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: 'traits はオブジェクトである必要があります。' };
  }

  const src = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const key of Object.keys(src)) {
    const v = src[key];
    if (v === null || v === undefined) continue; // 空欄は保存しない

    switch (key) {
      case 'bloom_season': {
        if (typeof v !== 'string' || !(BLOOM_SEASONS as readonly string[]).includes(v)) {
          return { ok: false, message: `bloom_season は ${BLOOM_SEASONS.join(' | ')} のいずれか。` };
        }
        out[key] = v;
        break;
      }
      case 'fragrance_strength': {
        if (
          typeof v !== 'number' ||
          !Number.isInteger(v) ||
          v < 0 ||
          v > TRAIT_FRAGRANCE_STRENGTH_MAX
        ) {
          return {
            ok: false,
            message: `fragrance_strength は 0〜${TRAIT_FRAGRANCE_STRENGTH_MAX} の整数。`,
          };
        }
        out[key] = v;
        break;
      }
      case 'fragrance_type': {
        const s = asText(v, FRAGRANCE_TYPE_MAX);
        if (!s) return { ok: false, message: `fragrance_type は 1〜${FRAGRANCE_TYPE_MAX} 文字。` };
        out[key] = s;
        break;
      }
      case 'plant_height_cm': {
        const n = asPositiveNumber(v, TRAIT_MAX_HEIGHT_CM);
        if (n === null) {
          return {
            ok: false,
            message: `plant_height_cm は 0 より大きい ${TRAIT_MAX_HEIGHT_CM} 以下の数値。`,
          };
        }
        out[key] = n;
        break;
      }
      case 'flower_size_cm': {
        const n = asPositiveNumber(v, TRAIT_MAX_FLOWER_CM);
        if (n === null) {
          return {
            ok: false,
            message: `flower_size_cm は 0 より大きい ${TRAIT_MAX_FLOWER_CM} 以下の数値。`,
          };
        }
        out[key] = n;
        break;
      }
      default:
        return { ok: false, message: '未対応の traits 項目が含まれています。' };
    }
  }

  return { ok: true, value: out };
}

// 有限・0 超・max 以下の数値のみ通す（小数可）。それ以外は null。
function asPositiveNumber(v: unknown, max: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > max) return null;
  return v;
}
