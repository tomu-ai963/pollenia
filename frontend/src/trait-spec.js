// 特性（plants.traits）の項目の定義。画面（入力欄・表示）と Worker（検証。worker/src/lib/traits.ts）が
// このファイルを共有する（項目の定義がずれないように 1 か所に置く）。ビルドなしの素の JS。
//
// - ジャンル（plants.genre）ごとに入力する項目が変わる。ジャンル未設定（これまでの個体）は「その他」と同じ項目
// - 保存する値: 選択肢は value（開花時期だけ英語のキー。ほかは表示と同じ日本語）、数値は number、文字は string
// - 項目を足すときは TRAITS に 1 行足すだけ（DB のマイグレーションは要らない）
// - label は全項目で重ならないようにする（CSV 取り込みの見出しを label で対応づけるため。テストで確かめる）

export const GENRES = [
  { value: 'rose', label: 'バラ' },
  { value: 'hellebore', label: 'クリスマスローズ' },
  { value: 'succulent', label: '多肉植物' },
  { value: 'vegetable', label: '野菜' },
  { value: 'other', label: 'その他' },
];

const opts = (...labels) => labels.map((l) => ({ value: l, label: l }));
const ALL = ['rose', 'hellebore', 'succulent', 'vegetable', 'other'];

export const TRAITS = [
  // --- 共通 ---
  { key: 'flower_color', label: '花色', type: 'text', max: 200, genres: ['rose', 'hellebore', 'other'] },
  {
    key: 'bloom_season',
    label: '開花時期',
    type: 'enum',
    values: [
      { value: 'spring', label: '春' },
      { value: 'early_summer', label: '初夏' },
      { value: 'summer', label: '夏' },
      { value: 'autumn', label: '秋' },
      { value: 'winter', label: '冬' },
    ],
    genres: ALL,
  },
  { key: 'plant_height_cm', label: '草丈', type: 'number', max: 10000, unit: 'cm', genres: ALL },
  { key: 'flower_size_cm', label: '花のサイズ', type: 'number', max: 1000, unit: 'cm', genres: ['rose', 'hellebore', 'other'] },
  { key: 'fragrance_strength', label: '香りの強さ', type: 'int', min: 0, max: 5, unit: '/ 5', genres: ['rose', 'other'] },
  { key: 'fragrance_type', label: '香りの系統', type: 'text', max: 200, genres: ['rose', 'other'] },
  // --- バラ ---
  {
    key: 'flower_form',
    label: '花形',
    type: 'enum',
    values: opts('剣弁高芯咲き', '丸弁平咲き', 'カップ咲き', 'ロゼット咲き', 'ポンポン咲き', '一重咲き', '半八重咲き'),
    genres: ['rose'],
  },
  { key: 'petal_count', label: '花弁数', type: 'int', min: 1, max: 1000, unit: '枚', genres: ['rose'] },
  { key: 'repeat_bloom', label: '四季性', type: 'enum', values: opts('一季咲き', '返り咲き', '四季咲き'), genres: ['rose'] },
  // --- クリスマスローズ ---
  {
    key: 'hellebore_form',
    label: '咲き方',
    type: 'enum',
    values: opts('シングル', 'セミダブル', 'ダブル', 'アネモネ咲き'),
    genres: ['hellebore'],
  },
  { key: 'picotee', label: 'ピコティ', type: 'enum', values: opts('なし', 'あり'), genres: ['hellebore'] },
  { key: 'spot', label: '模様', type: 'enum', values: opts('なし', 'スポット', 'ブロッチ', 'ベイン'), genres: ['hellebore'] },
  { key: 'nectary_color', label: 'ネクタリーの色', type: 'text', max: 200, genres: ['hellebore'] },
  // --- 多肉植物 ---
  { key: 'leaf_color', label: '葉色', type: 'text', max: 200, genres: ['succulent'] },
  { key: 'autumn_color', label: '紅葉', type: 'enum', values: opts('しない', '弱い', '中くらい', '強い'), genres: ['succulent'] },
  { key: 'farina', label: '粉', type: 'enum', values: opts('なし', '少ない', '多い'), genres: ['succulent'] },
  { key: 'claw', label: '爪', type: 'enum', values: opts('なし', 'あり'), genres: ['succulent'] },
  { key: 'variegation', label: '斑', type: 'enum', values: opts('なし', '覆輪', '中斑', '散り斑'), genres: ['succulent'] },
  { key: 'clustering', label: '群生', type: 'enum', values: opts('しない', 'する'), genres: ['succulent'] },
  // --- 野菜 ---
  { key: 'fruit_color', label: '実の色', type: 'text', max: 200, genres: ['vegetable'] },
  { key: 'fruit_weight_g', label: '実の重さ', type: 'number', max: 100000, unit: 'g', genres: ['vegetable'] },
  { key: 'sugar_brix', label: '糖度', type: 'number', max: 100, unit: '度', genres: ['vegetable'] },
  { key: 'days_to_harvest', label: '収穫までの日数', type: 'int', min: 1, max: 1000, unit: '日', genres: ['vegetable'] },
  // --- バラ・野菜 ---
  { key: 'disease_resistance', label: '耐病性', type: 'int', min: 1, max: 5, unit: '/ 5', genres: ['rose', 'vegetable'] },
];

export const TRAIT_BY_KEY = new Map(TRAITS.map((t) => [t.key, t]));

/** ジャンルの値 → 入力する項目（未設定・不明は「その他」） */
export function traitsForGenre(genre) {
  const g = GENRES.some((x) => x.value === genre) ? genre : 'other';
  return TRAITS.filter((t) => t.genres.includes(g));
}

export function genreLabel(genre) {
  return GENRES.find((g) => g.value === genre)?.label ?? null;
}

/**
 * 1 項目の検証。null / undefined / 空文字は「空欄」（{ ok: true, value: null }）。
 * エラーの文言には入力値を入れない（項目名と範囲だけ）。
 */
export function validateTrait(spec, v) {
  if (v === null || v === undefined || v === '') return { ok: true, value: null };
  switch (spec.type) {
    case 'enum': {
      if (typeof v !== 'string' || !spec.values.some((o) => o.value === v)) {
        return { ok: false, message: `${spec.label}は選択肢から選んでください。` };
      }
      return { ok: true, value: v };
    }
    case 'int': {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < spec.min || v > spec.max) {
        return { ok: false, message: `${spec.label}は ${spec.min}〜${spec.max} の整数です。` };
      }
      return { ok: true, value: v };
    }
    case 'number': {
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > spec.max) {
        return { ok: false, message: `${spec.label}は 0 より大きい ${spec.max} 以下の数値です。` };
      }
      return { ok: true, value: v };
    }
    case 'text': {
      const s = typeof v === 'string' ? v.trim() : '';
      if (!s || s.length > spec.max) return { ok: false, message: `${spec.label}は 1〜${spec.max} 文字です。` };
      return { ok: true, value: s };
    }
    default:
      return { ok: false, message: '未対応の特性の項目です。' };
  }
}

/** 保存された値 → 表示（「初夏」「4 / 5」「120 cm」） */
export function formatTraitValue(spec, v) {
  if (spec.type === 'enum') return spec.values.find((o) => o.value === v)?.label ?? String(v);
  if (spec.unit) return `${v} ${spec.unit}`;
  return String(v);
}

/** traits → [{ key, label, text }]（定義の順。知らないキー・定義に合わない値は出さない） */
export function traitEntries(traits) {
  if (!traits || typeof traits !== 'object' || Array.isArray(traits)) return [];
  return TRAITS.flatMap((t) => {
    const r = validateTrait(t, traits[t.key]);
    return r.ok && r.value !== null ? [{ key: t.key, label: t.label, text: formatTraitValue(t, r.value) }] : [];
  });
}
