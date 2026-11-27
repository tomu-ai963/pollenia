import { TRAIT_BY_KEY, validateTrait } from '../../../frontend/src/trait-spec.js';

// plants.traits（構造化特性）のパース／正規化。項目の定義は画面と共有の frontend/src/trait-spec.js。
//
// 方針:
//   * 全項目任意。空欄（null / undefined / 空文字）はキーごと落とす。結果が {} でも正当（未入力の個体）。
//   * 定義にある項目だけ受け付け、未知キーは拒否する。JSONB は自由形だが、AI が読む列に不定形・任意の
//     クライアント入力を溜め込ませない（データ衛生・プロンプト混入対策）。
//   * ジャンルと項目の組み合わせは縛らない（ジャンルを変えても入力済みの値は消さない。画面がジャンルの項目だけ出す）。
//   * エラー文言はクライアントの入力値を反映しない固定文言（項目名と範囲だけ）。

export type TraitParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string };

export function parsePlantTraits(input: unknown): TraitParseResult {
  // 未指定・null は「特性なし」= {}。
  if (input === null || input === undefined) return { ok: true, value: {} };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: 'traits はオブジェクトである必要があります。' };
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(input as Record<string, unknown>)) {
    const spec = TRAIT_BY_KEY.get(key);
    if (!spec) return { ok: false, message: '未対応の traits 項目が含まれています。' };
    const r = validateTrait(spec, v);
    if (!r.ok) return { ok: false, message: r.message };
    if (r.value !== null) out[key] = r.value;
  }
  return { ok: true, value: out };
}
