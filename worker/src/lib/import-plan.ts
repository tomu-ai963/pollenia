// CSV 取り込みの計画づくり（POST /api/import/plants。DB に依存しない部分）。
//
// 1 行 = 1 個体。母・父の欄に名前を書くと、交配 → 採種 → 播種 → 個体（origin_sowing_id）まで
// つないで系統として取り込む。親の名前は次の順に探す:
//   1) 同じ CSV の行  2) 自分の登録済みの個体（未削除・名前が一致して 1 件だけ）
//   3) どちらにも無ければ、その名前で導入株を自動で作る
// 父の欄: 空・「不明」「父不明」→ 父不明（null）、「自家」「自家受粉」または母と同じ名前 → 自家受粉。
// 同じ母・父・交配日の行（兄弟）は 1 つの交配にまとめる。
//
// 二重取り込みを防ぐため、登録済みの個体と同じ名前の行はエラーにする（重複した名前は親の解決もできなくなる）。
// エラーの文言に利用者の入力値は入れない（行番号と項目名だけ）。

import { MAX_NAME_LEN, MAX_TEXT_LEN } from '../constants';
import { parsePlantTraits } from './traits';
import { GENRES, TRAITS } from '../../../frontend/src/trait-spec.js';
import { asDateStr, asText } from './validate';

export const IMPORT_MAX_ROWS = 500;

/** 1 行。特性は trait-spec.js の key（bloom_season など）で入る。genre は「バラ」などの表示名か値 */
export interface ImportRow {
  name?: unknown;
  species?: unknown;
  genre?: unknown;
  mother?: unknown;
  father?: unknown;
  cross_date?: unknown;
  notes?: unknown;
  [traitKey: string]: unknown;
}

export interface ExistingPlant {
  id: string;
  name: string;
}

/** 新しく作る個体。key は 'new:<名前>'。row は CSV の行番号（1 始まり。自動で作る親は null） */
export interface NewPlant {
  key: string;
  name: string;
  species: string | null;
  genre: string | null;
  notes: string | null;
  traits: Record<string, unknown>;
  row: number | null;
}

/** 親の参照: 'existing:<id>' か 'new:<名前>' */
export interface PlannedCrossing {
  seedKey: string;
  pollenKey: string | null;
  crossDate: string | null;
  childKeys: string[];
}

export interface ImportPlan {
  plants: NewPlant[];
  crossings: PlannedCrossing[];
}

export interface ImportError {
  row: number;
  message: string;
}

const UNKNOWN_FATHER = new Set(['', '不明', '父不明', '?', '？']);
const SELF = new Set(['自家', '自家受粉', '自殖']);

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/** 2026/5/1・2026-05-01・2026.5.1 → 2026-05-01（不正なら null） */
export function normalizeDate(v: unknown): string | null {
  const s = str(v);
  const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (!m) return null;
  return asDateStr(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`);
}

/** 特性の欄 → traits。選択肢は表示名（「初夏」「四季咲き」）でも値でもよい。数値は文字から数にする */
function parseTraits(r: ImportRow): { ok: true; value: Record<string, unknown> } | { ok: false; field: string } {
  const t: Record<string, unknown> = {};
  for (const spec of TRAITS) {
    const raw = str(r[spec.key]);
    if (!raw) continue;
    if (spec.type === 'enum') {
      t[spec.key] = spec.values?.find((o) => o.label === raw || o.value === raw)?.value ?? raw;
    } else if (spec.type === 'int' || spec.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, field: spec.label };
      t[spec.key] = n;
    } else {
      t[spec.key] = raw;
    }
  }
  const parsed = parsePlantTraits(t);
  if (!parsed.ok) {
    const bad = TRAITS.find((spec) => spec.key in t && !parsePlantTraits({ [spec.key]: t[spec.key] }).ok);
    return { ok: false, field: bad?.label ?? '特性' };
  }
  return { ok: true, value: parsed.value };
}

/** 「バラ」などの表示名か値 → ジャンルの値。空は null、知らないものは undefined（エラー） */
function parseGenre(v: unknown): string | null | undefined {
  const s = str(v);
  if (!s) return null;
  return GENRES.find((g) => g.label === s || g.value === s)?.value;
}

export function planImport(
  rows: readonly ImportRow[],
  existing: readonly ExistingPlant[],
): { ok: true; plan: ImportPlan } | { ok: false; errors: ImportError[] } {
  const errors: ImportError[] = [];
  if (rows.length === 0) return { ok: false, errors: [{ row: 0, message: '取り込む行がありません。' }] };
  if (rows.length > IMPORT_MAX_ROWS) {
    return { ok: false, errors: [{ row: 0, message: `一度に取り込めるのは ${IMPORT_MAX_ROWS} 行までです。` }] };
  }

  const existingByName = new Map<string, string[]>();
  for (const p of existing) {
    const list = existingByName.get(p.name) ?? [];
    list.push(p.id);
    existingByName.set(p.name, list);
  }

  // 1) 各行の検証と、CSV 内の名前の一覧
  type Parsed = {
    row: number;
    name: string;
    species: string | null;
    genre: string | null;
    notes: string | null;
    traits: Record<string, unknown>;
    mother: string | null;
    father: string | null; // null = 父不明
    self: boolean;
    crossDate: string | null;
  };
  const parsed: Parsed[] = [];
  const rowByName = new Map<string, number>();
  rows.forEach((r, i) => {
    const row = i + 1;
    const name = asText(r.name, MAX_NAME_LEN);
    if (!name) return errors.push({ row, message: `名前は必須です（${MAX_NAME_LEN}文字以内）。` });
    if (rowByName.has(name)) {
      return errors.push({ row, message: '同じ名前の行がほかにもあります（名前は 1 行に 1 つ）。' });
    }
    rowByName.set(name, row);
    if (existingByName.has(name)) {
      return errors.push({ row, message: 'すでに同じ名前の個体が登録されています（二重の取り込みを防ぐため）。' });
    }
    const speciesRaw = str(r.species);
    const species = speciesRaw ? asText(speciesRaw, MAX_NAME_LEN) : null;
    if (speciesRaw && !species) return errors.push({ row, message: '属・種が長すぎます。' });
    const notesRaw = str(r.notes);
    const notes = notesRaw ? asText(notesRaw, MAX_TEXT_LEN) : null;
    if (notesRaw && !notes) return errors.push({ row, message: 'メモが長すぎます。' });
    const traits = parseTraits(r);
    if (!traits.ok) return errors.push({ row, message: `${traits.field}の値が正しくありません。` });
    const genre = parseGenre(r.genre);
    if (genre === undefined) {
      return errors.push({ row, message: `ジャンルは ${GENRES.map((g) => g.label).join('・')} のどれかです。` });
    }

    const motherRaw = str(r.mother);
    const fatherRaw = str(r.father);
    const mother = motherRaw ? asText(motherRaw, MAX_NAME_LEN) : null;
    if (motherRaw && !mother) return errors.push({ row, message: '母の名前が長すぎます。' });
    const self = !!mother && (SELF.has(fatherRaw) || fatherRaw === mother);
    const fatherName = self || UNKNOWN_FATHER.has(fatherRaw) ? null : asText(fatherRaw, MAX_NAME_LEN);
    if (!self && !UNKNOWN_FATHER.has(fatherRaw) && !fatherName) {
      return errors.push({ row, message: '父の名前が長すぎます。' });
    }
    if (!mother && (fatherName || self)) {
      return errors.push({ row, message: '父だけでは取り込めません。母（種子親）も書いてください。' });
    }
    if (mother === name || fatherName === name) {
      return errors.push({ row, message: '自分自身を親にはできません。' });
    }
    const crossRaw = str(r.cross_date);
    const crossDate = crossRaw ? normalizeDate(crossRaw) : null;
    if (crossRaw && !crossDate) return errors.push({ row, message: '交配日は 2026-05-01 の形で書いてください。' });
    if (!mother && crossDate) return errors.push({ row, message: '交配日は、母を書いた行にだけ書けます。' });

    parsed.push({
      row,
      name,
      species,
      genre,
      notes,
      traits: traits.value,
      mother,
      father: fatherName,
      self,
      crossDate,
    });
  });
  if (errors.length) return { ok: false, errors };

  // 2) 親の名前 → 参照。CSV の行 > 登録済み（1 件だけ）> 自動で作る導入株
  const plants: NewPlant[] = parsed.map((p) => ({
    key: `new:${p.name}`,
    name: p.name,
    species: p.species,
    genre: p.genre,
    notes: p.notes,
    traits: p.traits,
    row: p.row,
  }));
  const autoParents = new Map<string, NewPlant>();
  const resolve = (parentName: string, row: number): string | null => {
    if (rowByName.has(parentName)) return `new:${parentName}`;
    const ids = existingByName.get(parentName);
    if (ids && ids.length > 1) {
      errors.push({ row, message: '親と同じ名前の個体が複数登録されているため、どれか決められません。' });
      return null;
    }
    if (ids) return `existing:${ids[0]}`;
    if (!autoParents.has(parentName)) {
      autoParents.set(parentName, {
        key: `new:${parentName}`,
        name: parentName,
        species: null,
        genre: null,
        notes: null,
        traits: {},
        row: null,
      });
    }
    return `new:${parentName}`;
  };

  const crossingByKey = new Map<string, PlannedCrossing>();
  const parentsOf = new Map<string, string[]>(); // 子 key → 親 key（循環の検出用）
  for (const p of parsed) {
    if (!p.mother) continue;
    const seedKey = resolve(p.mother, p.row);
    const pollenKey = p.self ? seedKey : p.father ? resolve(p.father, p.row) : null;
    if (!seedKey || (p.father && !p.self && !pollenKey)) continue;
    const childKey = `new:${p.name}`;
    parentsOf.set(childKey, [seedKey, pollenKey].filter((k): k is string => !!k));
    const ck = `${seedKey}|${pollenKey ?? ''}|${p.crossDate ?? ''}`;
    const c = crossingByKey.get(ck);
    if (c) c.childKeys.push(childKey);
    else crossingByKey.set(ck, { seedKey, pollenKey, crossDate: p.crossDate, childKeys: [childKey] });
  }
  if (errors.length) return { ok: false, errors };

  // 3) 循環（A の親が B、B の親が A など）を弾く。CSV の行どうしの間でだけ起こりうる
  const state = new Map<string, 1 | 2>(); // 1 = たどっている途中, 2 = 済み
  const visit = (key: string): boolean => {
    if (state.get(key) === 2) return false;
    if (state.get(key) === 1) return true;
    state.set(key, 1);
    for (const parent of parentsOf.get(key) ?? []) if (visit(parent)) return true;
    state.set(key, 2);
    return false;
  };
  for (const p of parsed) {
    if (visit(`new:${p.name}`)) {
      return { ok: false, errors: [{ row: p.row, message: '親子関係が輪になっています（祖先に自分が含まれる）。' }] };
    }
  }

  return { ok: true, plan: { plants: [...plants, ...autoParents.values()], crossings: [...crossingByKey.values()] } };
}
