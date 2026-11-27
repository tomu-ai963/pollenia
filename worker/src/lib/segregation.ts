import { TRAITS, formatTraitValue, validateTrait } from '../../../frontend/src/trait-spec.js';

// 形質の分離（GET /api/analytics/segregation）。交配から生まれた子（実生の個体）の特性が
// どう分かれたかを数える。項目の定義は frontend/src/trait-spec.js。
//
// - 選択肢・文字の項目: 値ごとの本数（多い順）。文字は前後の空白だけそろえて、そのまま数える
// - 数値の項目: 件数・最小・最大・平均（小数 1 桁）
// - 記録の無い子は、その項目では数えない（recorded に入れた本数を出す）
// - 定義に合わない値（過去データ）は数えない

export interface CategoryStat {
  key: string;
  label: string;
  type: 'category';
  recorded: number;
  counts: { value: string; n: number }[];
}
export interface NumberStat {
  key: string;
  label: string;
  type: 'number';
  recorded: number;
  min: number;
  max: number;
  avg: number;
  unit: string | null;
}
export type TraitStat = CategoryStat | NumberStat;

export function summarizeOffspring(traitsList: readonly unknown[]): TraitStat[] {
  const out: TraitStat[] = [];
  for (const spec of TRAITS) {
    const values = traitsList.flatMap((t) => {
      const raw = t && typeof t === 'object' && !Array.isArray(t) ? (t as Record<string, unknown>)[spec.key] : undefined;
      const r = validateTrait(spec, raw);
      return r.ok && r.value !== null ? [r.value] : [];
    });
    if (values.length === 0) continue;
    if (spec.type === 'int' || spec.type === 'number') {
      const nums = values as number[];
      out.push({
        key: spec.key,
        label: spec.label,
        type: 'number',
        recorded: nums.length,
        min: Math.min(...nums),
        max: Math.max(...nums),
        avg: Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10,
        unit: spec.unit ?? null,
      });
    } else {
      const counts = new Map<string, number>();
      for (const v of values) {
        const label = formatTraitValue(spec, v);
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      out.push({
        key: spec.key,
        label: spec.label,
        type: 'category',
        recorded: values.length,
        counts: [...counts.entries()]
          .map(([value, n]) => ({ value, n }))
          .sort((a, b) => b.n - a.n || (a.value < b.value ? -1 : 1)),
      });
    }
  }
  return out;
}
